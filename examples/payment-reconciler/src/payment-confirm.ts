/**
 * `runPaymentConfirmationScenario`: the second scenario beside `runScenario`
 * (Phase 10, PSTK-06, PSTK-07). It composes the same harness pieces (a shared
 * deterministic clock, a per-scenario `mkdtemp` store, `createRealDeps`-based
 * deps, the scripted host adapter, the in-memory MCP transport pair, a `finally`
 * that stops every server) for the payment-confirmation flow:
 *
 *   sign the delegated manifest -> `stint create --credentials` (the typed
 *   inputs arrive through the typed-entry seam, the API key through a
 *   credentials-file `api_key` entry carrying the mock's loopback origin) ->
 *   serve the lease -> the agent verifies and asks for a check -> the run
 *   stops -> the USER runs `stint-cli verify-outcome` (one or more times) ->
 *   teardown -> receipts.
 *
 * Two worlds, one flow. Hermetic (default): a verify-capable mock Paystack on
 * loopback, every fixture and fault configurable. Real: the same flow against
 * the real provider origin with a key and an already-initialized reference
 * supplied by the caller (the env-gated test-mode e2e); the credential entry
 * then carries NO origin, so the key can only ever resolve to the closed
 * provider table's `https://api.paystack.co`.
 *
 * Nothing in here re-implements enforcement. No sleeps: the flow waits on the
 * agent's awaited calls and on the commands' own exit codes.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRealDeps, createStyle, main, runLease } from "@stint/cli";
import type { CliDeps, RunningLease } from "@stint/cli";
import { mergeTimeline } from "@stint/core";
import type { ConsentRequest, Lease, LifecycleEvent, TimelineEntry } from "@stint/core";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { parseEnvelope, verifyEnvelope } from "@stint/spec";
import type { Manifest, ReceiptEntry, VerifiedManifest } from "@stint/spec";

import { connectAgent } from "./agent.js";
import type { AgentStep, ConnectedAgent } from "./agent.js";
import { buildSignedPaymentManifest, writeManifestFiles } from "./manifest.js";
import { DEFAULT_VERIFY_REFERENCE, startPaystackMock } from "./mocks/services.js";
import type { PaystackMock, PaystackVerifyFixture, RecordedRequest } from "./mocks/services.js";
import { buildPaymentRunProfile, PAYMENT_TOOL, PAYSTACK_RESOURCE, writeJsonProfile } from "./profile.js";
import { createScriptedAdapter } from "./scripted-adapter.js";
import type { ScriptedAdapter } from "./scripted-adapter.js";
import { SCENARIO_NOW } from "./scenario.js";
import type { ScenarioClock } from "./scenario.js";

/** The fixture API key the hermetic scenario seeds. A SECRET-shaped value: scans look for it, nothing prints it. */
export const FIXTURE_API_KEY = "sk_test_fixture_payment_confirm_key_do_not_leak";

/** The job's three fixed inputs as the scripted user types them (they match the default mock fixture). */
export const DEFAULT_PAYMENT_PARAMETERS: Readonly<Record<string, string>> = {
  reference: DEFAULT_VERIFY_REFERENCE,
  expected_amount_kobo: "30050",
  currency: "NGN",
};

/** The default agent script: verify the payment, then ask the user for the completion check. */
export const DEFAULT_PAYMENT_SCRIPT: readonly PaymentAgentStep[] = [
  { name: PAYMENT_TOOL },
  { name: "request_outcome_check" },
];

/** One agent tool call. */
export interface PaymentAgentStep {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

/** Live handles a check's `before` hook can reach (e.g. to correct a fixture or arm a one-shot fault). */
export interface PaymentCheckContext {
  readonly clock: ScenarioClock;
  /** The mock Paystack; `undefined` in real mode (there is no mock to steer). */
  readonly paystack: PaystackMock | undefined;
  readonly leaseId: string;
}

/** One `stint-cli verify-outcome` invocation; `before` runs first. */
export interface PaymentCheckStep {
  readonly before?: (context: PaymentCheckContext) => void | Promise<void>;
}

/** What one `verify-outcome` run produced. */
export interface PaymentCheckResult {
  readonly code: number;
  /** Only what this invocation wrote to stdout. */
  readonly out: string;
  /** Only what this invocation wrote to stderr. */
  readonly err: string;
  /** The lease state right after this invocation. */
  readonly stateAfter: Lease["state"] | undefined;
}

/** Real-mode inputs: a key and an already-initialized (and paid) transaction. No origin is ever supplied. */
export interface PaymentRealMode {
  readonly apiKey: string;
  readonly reference: string;
  readonly expectedAmountKobo: number;
  readonly currency: string;
}

export interface PaymentConfirmScenarioOptions {
  /**
   * Hermetic only: the mock's verify answers by reference (a reference absent from
   * the map answers 404). Default: one success fixture for `ref_1001`.
   */
  readonly verify?: Readonly<Record<string, PaystackVerifyFixture>>;
  /** The user's typed answers, by parameter name. Default {@link DEFAULT_PAYMENT_PARAMETERS}; hermetic only. */
  readonly parameters?: Readonly<Record<string, string | undefined>>;
  /** The agent's tool calls. Default {@link DEFAULT_PAYMENT_SCRIPT}. */
  readonly script?: readonly PaymentAgentStep[];
  /** The user's `verify-outcome` runs, in order. Default: one. */
  readonly checks?: readonly PaymentCheckStep[];
  /** `manifest.approvals.timeout_seconds`. Default 30. */
  readonly approvalTimeoutSeconds?: number;
  /** Run against the real provider origin instead of the mock. */
  readonly real?: PaymentRealMode;
}

/** Everything observable after a payment scenario. Plain values: safe to read after every server has stopped. */
export interface PaymentConfirmResult {
  readonly leaseId: string;
  readonly root: string;
  readonly manifest: Manifest;
  readonly exitCodes: { readonly create: number };
  /** Every consent request the adapter received (the data the terminal renders). */
  readonly consentRequests: readonly ConsentRequest[];
  readonly toolNames: readonly string[];
  /** Every agent-visible result, one per scripted step. */
  readonly results: readonly CallToolResult[];
  /** The lease right after `create` activated it. */
  readonly leaseAfterCreate: Lease | undefined;
  /** The lease after the agent's calls and before the first user check. */
  readonly leaseBeforeCheck: Lease | undefined;
  readonly checks: readonly PaymentCheckResult[];
  /** The lease as persisted at the end. */
  readonly lease: Lease | undefined;
  readonly verifiedReceipts: readonly ReceiptEntry[];
  readonly attestedReceipts: readonly ReceiptEntry[];
  readonly timeline: readonly TimelineEntry[];
  /** Every request the mock Paystack recorded (empty in real mode). */
  readonly paystackRequests: readonly RecordedRequest[];
  readonly as: { readonly tokenEndpointHits: number; readonly revokeHits: number };
  /** Everything the CLI wrote to stdout and stderr, create included. */
  readonly cliOutput: string;
  readonly events: readonly LifecycleEvent[];
  /** The API key the scenario ran with (a SECRET: for leak scans only, never printed). */
  readonly secrets: readonly string[];
  readonly finalNow: number;
  /** Concatenated text of every file under the store root. */
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

/** Runs one payment-confirmation scenario end to end and returns its observables. Servers are always stopped. */
export async function runPaymentConfirmationScenario(
  options: PaymentConfirmScenarioOptions = {},
): Promise<PaymentConfirmResult> {
  const real = options.real;
  const script = options.script ?? DEFAULT_PAYMENT_SCRIPT;
  const checkSteps = options.checks ?? [{}];
  const apiKey = real?.apiKey ?? FIXTURE_API_KEY;
  const typedAnswers: Readonly<Record<string, string | undefined>> =
    real === undefined
      ? { ...DEFAULT_PAYMENT_PARAMETERS, ...options.parameters }
      : {
          reference: real.reference,
          expected_amount_kobo: String(real.expectedAmountKobo),
          currency: real.currency,
        };

  const clock: ScenarioClock = {
    now: SCENARIO_NOW,
    advance(seconds) {
      this.now += seconds;
    },
  };
  const now = (): number => clock.now;

  const workDir = await mkdtemp(path.join(tmpdir(), "alp-pay-e2e-"));
  const root = path.join(workDir, "store");
  await mkdir(root, { recursive: true });

  const stoppers: Array<() => Promise<void>> = [];
  let agent: ConnectedAgent | undefined;
  let running: RunningLease | undefined;

  try {
    // 1. The world. The authorization server exists only because a run profile carries an OAuth
    // block; the API key must never reach it (the result counts its hits).
    const as: MockAuthHarness = await startMockAuthServer();
    stoppers.push(() => as.stop());
    let paystack: PaystackMock | undefined;
    if (real === undefined) {
      paystack = await startPaystackMock(options.verify === undefined ? {} : { verify: options.verify });
      stoppers.push(() => (paystack as PaystackMock).stop());
    }

    // 2. The key arrives through the credentials file: an api_key entry. The mock's loopback origin
    // rides the entry (hermetic); real mode names no origin, so the closed provider table decides.
    const credentialsFile = path.join(workDir, "credentials.json");
    await writeFile(
      credentialsFile,
      JSON.stringify({
        [PAYSTACK_RESOURCE]: {
          kind: "api_key",
          key: apiKey,
          ...(paystack === undefined ? {} : { origin: new URL(paystack.url).origin }),
        },
      }),
    );

    // 3. The signed delegated manifest and its trust entry.
    const built = await buildSignedPaymentManifest({
      approvalTimeoutSeconds: options.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS,
    });
    const { manifestPath } = await writeManifestFiles(root, built);

    // 4. `stint create`: verify, typed entry, consent, activate. The scripted adapter records the request.
    const adapter: ScriptedAdapter = createScriptedAdapter({ consent: "grant" });
    const out: string[] = [];
    const err: string[] = [];
    // The keychain is the default custody; the scenario asserts against the file store, so it opts in.
    process.env.STINT_SECRET_STORE ??= "file";
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
      // The scripted user types the job's fixed inputs; a name with no answer declines the create.
      askJobParameter: (ask) => Promise.resolve(typedAnswers[ask.name]),
    };
    const cli = async (
      argv: readonly string[],
    ): Promise<{ code: number; out: string; err: string }> => {
      const outStart = out.length;
      const errStart = err.length;
      const code = await main(["--store", root, ...argv], deps);
      return { code, out: out.slice(outStart).join(""), err: err.slice(errStart).join("") };
    };

    const created = await cli(["create", manifestPath, "--credentials", credentialsFile]);
    const store = deps.storeFactory(root);
    const leaseId =
      created.code === 0
        ? (created.out.split("\n")[0] ?? "").trim()
        : ((await store.list())[0]?.id ?? "");
    const leaseAfterCreate = leaseId === "" ? undefined : await store.load(leaseId);

    let toolNames: readonly string[] = [];
    const results: CallToolResult[] = [];
    const checks: PaymentCheckResult[] = [];
    let leaseBeforeCheck: Lease | undefined;

    if (created.code === 0) {
      // 5. Serve the lease and run the agent: it only ever sees tools/list and tool results.
      const parsed = parseEnvelope(built.envelopeBytes);
      if (!parsed.ok) throw new Error("scenario: the built manifest did not parse.");
      const verifiedResult = await verifyEnvelope(parsed.value, built.trustEntry);
      if (!verifiedResult.ok) throw new Error("scenario: the built manifest did not verify.");
      const verified: VerifiedManifest = verifiedResult.value;

      const profile = buildPaymentRunProfile({ mockAs: as });
      const [clientHalf, serverHalf] = InMemoryTransport.createLinkedPair();
      running = await runLease({
        leaseId,
        root,
        transport: serverHalf,
        adapter,
        deps,
        verified,
        profile,
      });

      agent = await connectAgent(clientHalf);
      toolNames = agent.toolNames;
      for (const step of script) {
        const agentStep: AgentStep = {
          name: step.name,
          ...(step.arguments === undefined ? {} : { arguments: step.arguments }),
        };
        results.push(await agent.call(agentStep));
      }
      leaseBeforeCheck = await store.load(leaseId);

      // 6. The agent goes away and the run stops; the lease is still active. Completion is the USER's:
      // `stint-cli verify-outcome` against a JSON profile that names the built-in verdict adapter.
      await agent.close();
      agent = undefined;
      await running.close();
      await running.closed;
      running = undefined;

      const jsonProfile = await writeJsonProfile(profile, path.join(workDir, "payment-profile.json"));
      const context: PaymentCheckContext = { clock, paystack, leaseId };
      for (const step of checkSteps) {
        await step.before?.(context);
        const ran = await cli(["verify-outcome", leaseId, "--profile", jsonProfile]);
        checks.push({
          code: ran.code,
          out: ran.out,
          err: ran.err,
          stateAfter: (await store.load(leaseId))?.state,
        });
      }
    }

    // 7. Observables.
    const lease = leaseId === "" ? undefined : await store.load(leaseId);
    const receiptStore = deps.receiptStoreFactory(root, leaseId === "" ? "none" : leaseId);
    const verifiedReceipts = leaseId === "" ? [] : await receiptStore.load("verified");
    const attestedReceipts = leaseId === "" ? [] : await receiptStore.load("attested");

    return {
      leaseId,
      root,
      manifest: built.manifest,
      exitCodes: { create: created.code },
      consentRequests: [...adapter.consentRequests],
      toolNames,
      results,
      leaseAfterCreate,
      leaseBeforeCheck,
      checks,
      lease,
      verifiedReceipts,
      attestedReceipts,
      timeline: mergeTimeline(verifiedReceipts, attestedReceipts),
      paystackRequests: paystack === undefined ? [] : [...paystack.requests],
      as: { tokenEndpointHits: as.tokenEndpointHits, revokeHits: as.revokeHits },
      cliOutput: [...out, ...err].join(""),
      events: [...adapter.events],
      secrets: [apiKey],
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
