/**
 * `runScenario`: the reusable in-process e2e orchestrator (D-01, D-02, D-15).
 *
 * One call stands up the whole hermetic world on loopback (a mock OAuth
 * authorization server, the mock publisher, the Paystack and orders-sheet
 * services), drives the REAL shipped runtime through it, and returns every
 * observable a test could want:
 *
 *   acquire (headless PKCE, per resource) -> sign the hybrid manifest ->
 *   `stint create --publisher` (license issued, lease ACTIVE) ->
 *   `runLease` behind an `InMemoryTransport` pair with a scripted HostAdapter ->
 *   the agent stub's tool calls -> end the lease (verifier / revoke / expiry) ->
 *   teardown -> receipts.
 *
 * Nothing in here re-implements enforcement: the proxy, vault, license custody,
 * teardown and receipts are the shipped ones. Determinism: every server binds
 * loopback port 0, the store is a per-scenario `mkdtemp`, ONE injected clock is
 * shared by the runtime, the publisher and the credential acquisition, and there
 * are no sleeps: the flow waits on the agent's own awaited calls and on
 * `running.closed`.
 *
 * Built scenario-parameterized so later scenarios only add test files. Every
 * server is stopped and the agent closed in a `finally`.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRealDeps, createStyle, main, runLease } from "@stint/cli";
import type { CliDeps, LoadedCredential, RunningLease } from "@stint/cli";
import { createPublisherClient } from "@stint/cli";
import { mergeTimeline } from "@stint/core";
import type { Lease, LifecycleEvent, ApprovalRequest, TimelineEntry } from "@stint/core";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { parseEnvelope, verifyEnvelope } from "@stint/spec";
import type { Manifest, ReceiptEntry, VerifiedManifest } from "@stint/spec";

import { connectAgent } from "./agent.js";
import type { AgentStep, ConnectedAgent } from "./agent.js";
import { buildSignedManifest, writeManifestFiles } from "./manifest.js";
import { startMockPublisher } from "./mocks/publisher.js";
import type { MockPublisher } from "./mocks/publisher.js";
import { startServices } from "./mocks/services.js";
import type { OrderRow, OrdersSheetMock, RecordedRequest, ServiceMock } from "./mocks/services.js";
import { acquireCredentialsFile, writeCredentialsFile } from "./oauth/acquire.js";
import { buildRunProfile, PAYSTACK_RESOURCE, SHEETS_RESOURCE } from "./profile.js";
import { createScriptedAdapter } from "./scripted-adapter.js";
import type { ScriptedAdapter, ScriptedApproval } from "./scripted-adapter.js";

/** Epoch seconds the shared clock starts at. */
export const SCENARIO_NOW = 1_800_000_000;

/** The shared, mutable test clock. The runtime, the publisher and credential acquisition all read it. */
export interface ScenarioClock {
  now: number;
  /** Moves time forward by `seconds` (no sleeping). */
  advance(seconds: number): void;
}

/** Live handles a step hook can reach (e.g. to move the clock or arm a one-shot fault before a call). */
export interface ScenarioContext {
  readonly clock: ScenarioClock;
  readonly as: MockAuthHarness;
  readonly publisher: MockPublisher;
  readonly paystack: ServiceMock;
  readonly sheets: OrdersSheetMock;
  readonly leaseId: string;
}

/** One agent tool call; `before` runs first with the live handles. */
export interface ScenarioStep {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly before?: (context: ScenarioContext) => void | Promise<void>;
}

/** How the scenario ends the lease after the script. */
export type ScenarioEnd =
  | "verify" // RunningLease.verifyOutcome(): resource_query -> completed -> teardown
  | "revoke" // `stint revoke --yes` while the proxy is still serving
  | "expire-cleanup" // move the clock past expiry, then `stint cleanup --yes`
  | "none"; // leave the lease as the script left it

export interface ScenarioConfig {
  /** The agent's tool calls. Default: {@link HAPPY_SCRIPT}. */
  readonly script?: readonly ScenarioStep[];
  /** How the lease ends. Default `"verify"`. */
  readonly end?: ScenarioEnd;
  /** Scripted answer to each per-call approval, in order. Default `["approve"]`. */
  readonly approvals?: readonly ScriptedApproval[];
  /** Consent answer for `stint create`. Default `"grant"`. */
  readonly consent?: "grant" | "decline";
  /** `manifest.approvals.timeout_seconds`. Default 30; use 1-2 only where a timeout is the assertion. */
  readonly approvalTimeoutSeconds?: number;
  /** Arm the publisher's cleanup hook to answer 500 once, right before the lease ends (D-10). */
  readonly failNextCleanup?: boolean;
  /** After a `cleanup_incomplete`, run `stint cleanup --yes` once more (the hook is healthy again). */
  readonly retryCleanup?: boolean;
  /** One more agent call made AFTER the lease ended, to observe a denial. */
  readonly postEndCall?: ScenarioStep;
  /** Make the FIRST acquired access token live only 1s, so the first call forces a real vault refresh. */
  readonly forceShortAccessTokenLifetime?: boolean;
}

/** The happy-path agent script: read the ledger, read the orders, then write one (irreversible, approved). */
export const HAPPY_SCRIPT: readonly ScenarioStep[] = [
  { name: "list_transactions" },
  { name: "read_orders" },
  { name: "mark_order_reconciled", arguments: { order_id: "ord_1001", status: "reconciled" } },
];

/** Everything observable after a scenario. Plain values: safe to read after every server has stopped. */
export interface ScenarioResult {
  readonly leaseId: string;
  readonly root: string;
  readonly manifest: Manifest;
  readonly toolNames: readonly string[];
  /** Every agent-visible `CallToolResult`, one per scripted step. */
  readonly results: readonly CallToolResult[];
  /** The result of `postEndCall`, when one was configured. */
  readonly postEndResult: CallToolResult | undefined;
  /** The lease as persisted at the end (`undefined` only if create never persisted one). */
  readonly lease: Lease | undefined;
  readonly verifiedReceipts: readonly ReceiptEntry[];
  readonly attestedReceipts: readonly ReceiptEntry[];
  /** `mergeTimeline` over both chains: the display-only success signal (D-12). */
  readonly timeline: readonly TimelineEntry[];
  readonly paystackRequests: readonly RecordedRequest[];
  readonly sheetsRequests: readonly RecordedRequest[];
  readonly sheetsRows: readonly OrderRow[];
  readonly as: { readonly tokenEndpointHits: number; readonly revokeHits: number };
  readonly publisher: {
    readonly issueHits: number;
    readonly reissueHits: number;
    readonly invalidateHits: number;
    readonly cleanupHits: number;
    readonly seenJtis: readonly string[];
    readonly invalidatedLeaseIds: readonly string[];
    readonly issuedTokens: readonly string[];
  };
  /** The publisher's license verification key (PASERK), for offline license checks. */
  readonly licensePublicKey: string;
  readonly credentials: Readonly<Record<string, LoadedCredential>>;
  /** Exit codes of the CLI invocations the scenario ran (`undefined` when not run). */
  readonly exitCodes: {
    readonly create: number;
    readonly end: number | undefined;
    readonly retry: number | undefined;
    readonly verify: number | undefined;
  };
  /** Everything the CLI wrote to stdout and stderr during the scenario. */
  readonly cliOutput: string;
  readonly events: readonly LifecycleEvent[];
  readonly approvalRequests: readonly ApprovalRequest[];
  /** Every secret-shaped value in play: access/refresh tokens seen anywhere and every license issued. */
  readonly secrets: readonly string[];
  /** The shared clock when the scenario finished. */
  readonly finalNow: number;
  /** Concatenated text of every file under the store root (for "no secret persisted" scans). */
  readonly readStoreText: () => Promise<string>;
  /** Runs a `stint` command against the scenario's store (works after the servers stopped). */
  readonly cli: (argv: readonly string[]) => Promise<{ code: number; out: string; err: string }>;
  /** Removes the scenario's temp directory. */
  readonly dispose: () => Promise<void>;
}

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 30;

async function readTree(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) parts.push(await readTree(full));
    else parts.push(await readFile(full, "utf8"));
  }
  return parts.join("\n");
}

function bearerOf(request: RecordedRequest): string | undefined {
  const header = request.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
}

/** Runs one scenario end to end and returns its observables. Servers are always stopped. */
export async function runScenario(config: ScenarioConfig = {}): Promise<ScenarioResult> {
  const script = config.script ?? HAPPY_SCRIPT;
  const end: ScenarioEnd = config.end ?? "verify";
  const approvals = config.approvals ?? ["approve"];

  const clock: ScenarioClock = {
    now: SCENARIO_NOW,
    advance(seconds) {
      this.now += seconds;
    },
  };
  const now = (): number => clock.now;

  const workDir = await mkdtemp(path.join(tmpdir(), "alp-e2e-"));
  const root = path.join(workDir, "store");
  await mkdir(root, { recursive: true });

  const stoppers: Array<() => Promise<void>> = [];
  let agent: ConnectedAgent | undefined;
  let running: RunningLease | undefined;

  try {
    // 1. The hermetic world: authorization server, publisher, customer services.
    const as = await startMockAuthServer();
    stoppers.push(() => as.stop());
    const publisher = await startMockPublisher({ now });
    stoppers.push(() => publisher.stop());
    const services = await startServices();
    stoppers.push(() => services.stop());
    const { paystack, sheets } = services;

    // 2. Headless PKCE acquisition for both resources (the platform's consent UX stand-in).
    if (config.forceShortAccessTokenLifetime === true) as.forceNextExpiresIn(1);
    const credentials = await acquireCredentialsFile(as, [PAYSTACK_RESOURCE, SHEETS_RESOURCE], now);
    const credentialsFile = await writeCredentialsFile(
      credentials,
      path.join(workDir, "credentials.json"),
    );

    // 3. The signed hybrid manifest (cleanup hook -> the mock publisher) and its trust entry.
    const built = await buildSignedManifest({
      cleanupUrl: publisher.cleanupUrl,
      approvalTimeoutSeconds: config.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS,
    });
    const { manifestPath } = await writeManifestFiles(root, built);
    const bindingFile = path.join(workDir, "publisher.json");
    await writeFile(
      bindingFile,
      JSON.stringify({
        issue_url: publisher.issueUrl,
        reissue_url: publisher.reissueUrl,
        invalidate_url: publisher.invalidateUrl,
        license_public_key: publisher.licensePublicKeyPaserk,
      }),
    );

    // 4. `stint create --publisher`: verify, consent, issue the license once, activate.
    const adapter: ScriptedAdapter = createScriptedAdapter({
      consent: config.consent ?? "grant",
      approvals,
    });
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      ...createRealDeps(),
      io: {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      },
      clock: now,
      style: () => createStyle(false),
      adapterFactory: () => adapter,
      confirm: () => Promise.resolve(undefined),
    };
    const cli = async (
      argv: readonly string[],
    ): Promise<{ code: number; out: string; err: string }> => {
      const outStart = out.length;
      const errStart = err.length;
      const code = await main(["--store", root, ...argv], deps);
      return { code, out: out.slice(outStart).join(""), err: err.slice(errStart).join("") };
    };

    const created = await cli(["create", manifestPath, "--publisher", bindingFile]);
    const store = deps.storeFactory(root);
    const leaseId =
      created.code === 0
        ? (created.out.split("\n")[0] ?? "").trim()
        : ((await store.list())[0]?.id ?? "");

    const exitCodes = {
      create: created.code,
      end: undefined as number | undefined,
      retry: undefined as number | undefined,
      verify: undefined as number | undefined,
    };
    let toolNames: readonly string[] = [];
    const results: CallToolResult[] = [];
    let postEndResult: CallToolResult | undefined;

    const context: ScenarioContext = { clock, as, publisher, paystack, sheets, leaseId };
    const toAgentStep = (step: ScenarioStep): AgentStep => ({
      name: step.name,
      ...(step.arguments === undefined ? {} : { arguments: step.arguments }),
      before: () => step.before?.(context),
    });

    if (created.code === 0) {
      // The cleanup hook verifies the runtime's EdDSA bearer against the key `create` just made.
      publisher.setRuntimePublicKey(await deps.keys.loadPublic(root));

      // 5. Serve the lease: the real proxy behind one half of an in-memory transport pair.
      const parsed = parseEnvelope(built.envelopeBytes);
      if (!parsed.ok) throw new Error("scenario: the built manifest did not parse.");
      const verifiedResult = await verifyEnvelope(parsed.value, built.trustEntry);
      if (!verifiedResult.ok) throw new Error("scenario: the built manifest did not verify.");
      const verified: VerifiedManifest = verifiedResult.value;

      const profile = buildRunProfile({
        mockAs: as,
        paystackUrl: paystack.url,
        sheetsUrl: sheets.url,
      });
      const [clientHalf, serverHalf] = InMemoryTransport.createLinkedPair();
      running = await runLease({
        leaseId,
        root,
        transport: serverHalf,
        adapter,
        deps,
        verified,
        profile,
        credentials,
        licenseIssuer: await createPublisherClient(
          {
            issue_url: publisher.issueUrl,
            reissue_url: publisher.reissueUrl,
            invalidate_url: publisher.invalidateUrl,
            license_public_key: publisher.licensePublicKeyPaserk,
          },
          verified.manifest.spec_version,
        ),
      });

      // 6. The agent: it only ever sees tools/list and tool results.
      agent = await connectAgent(clientHalf);
      toolNames = agent.toolNames;
      for (const step of script) results.push(await agent.call(toAgentStep(step)));

      // 7. End the lease.
      if (config.failNextCleanup === true) publisher.failNextCleanup();
      const credentialArgs = ["--yes", "--credentials", credentialsFile];
      if (end === "verify") {
        await running.verifyOutcome();
      } else if (end === "revoke") {
        exitCodes.end = (await cli(["revoke", leaseId, ...credentialArgs])).code;
      } else if (end === "expire-cleanup") {
        const current = await store.load(leaseId);
        if (current !== undefined) clock.now = current.expiresAt + 1;
        exitCodes.end = (await cli(["cleanup", leaseId, ...credentialArgs])).code;
      }

      if (config.postEndCall !== undefined) {
        postEndResult = await agent.call(toAgentStep(config.postEndCall));
      }

      if (config.retryCleanup === true) {
        const after = await store.load(leaseId);
        if (after?.state === "cleanup_incomplete") {
          exitCodes.retry = (await cli(["cleanup", leaseId, ...credentialArgs])).code;
        }
      }

      // 8. Disconnect the agent and wait for the proxy's transport to close.
      await agent.close();
      agent = undefined;
      await running.closed;
      running = undefined;
    }

    // 9. Observables.
    const lease = leaseId === "" ? undefined : await store.load(leaseId);
    const receiptStore = deps.receiptStoreFactory(root, leaseId === "" ? "none" : leaseId);
    const verifiedReceipts = leaseId === "" ? [] : await receiptStore.load("verified");
    const attestedReceipts = leaseId === "" ? [] : await receiptStore.load("attested");
    if (leaseId !== "" && lease !== undefined && verifiedReceipts.length > 0) {
      exitCodes.verify = (await cli(["verify", leaseId])).code;
    }

    const paystackRequests = [...paystack.requests];
    const sheetsRequests = [...sheets.requests];
    const secrets = new Set<string>();
    for (const credential of Object.values(credentials)) {
      secrets.add(credential.accessToken);
      secrets.add(credential.refreshToken);
    }
    for (const request of [...paystackRequests, ...sheetsRequests]) {
      const bearer = bearerOf(request);
      if (bearer !== undefined) secrets.add(bearer);
    }
    for (const token of publisher.issuedTokens) secrets.add(token);

    return {
      leaseId,
      root,
      manifest: built.manifest,
      toolNames,
      results,
      postEndResult,
      lease,
      verifiedReceipts,
      attestedReceipts,
      timeline: mergeTimeline(verifiedReceipts, attestedReceipts),
      paystackRequests,
      sheetsRequests,
      sheetsRows: sheets.rows.map((row) => ({ ...row })),
      as: { tokenEndpointHits: as.tokenEndpointHits, revokeHits: as.revokeHits },
      publisher: {
        issueHits: publisher.issueHits,
        reissueHits: publisher.reissueHits,
        invalidateHits: publisher.invalidateHits,
        cleanupHits: publisher.cleanupHits,
        seenJtis: [...publisher.seenJtis],
        invalidatedLeaseIds: [...publisher.invalidatedLeaseIds],
        issuedTokens: [...publisher.issuedTokens],
      },
      licensePublicKey: publisher.licensePublicKeyPaserk,
      credentials,
      exitCodes,
      cliOutput: [...out, ...err].join(""),
      events: [...adapter.events],
      approvalRequests: [...adapter.approvalRequests],
      secrets: [...secrets],
      finalNow: clock.now,
      readStoreText: () => readTree(root),
      cli,
      dispose: () => rm(workDir, { recursive: true, force: true, maxRetries: 5 }),
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  } finally {
    await agent?.close().catch(() => undefined);
    await running?.close().catch(() => undefined);
    for (const stop of stoppers.reverse()) await stop();
  }
}
