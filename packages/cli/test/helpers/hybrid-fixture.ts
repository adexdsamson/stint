/**
 * Shared rig for the hybrid `runLease` tests (plan 07-04): a REAL hybrid lease
 * created through `stint create --publisher` (publisher stub), a loopback mock
 * authorization server, and two loopback `node:http` "customer API" mocks that
 * the real REST connector reaches through the profile's `endpoints` map. The
 * clock is a mutable shared one so a test can move time without sleeping.
 */

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBindingSet } from "@stint/core";
import type { ConnectorBinding } from "@stint/core";
import { createLicenseIssuerClient, importLicensePublicKey } from "@stint/core/license-issuer";
import type { LicenseIssuerClient } from "@stint/core/license-issuer";
import { createToolCatalog } from "@stint/proxy";
import type { FetchLike, SeededCredential } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import type { Manifest, VerifiedManifest } from "@stint/spec";

import type { CliDeps } from "../../src/deps.js";
import { httpIssuerTransport } from "../../src/run/license-http.js";
import type { RunProfile } from "../../src/run/profile.js";
import { runLease } from "../../src/run/run-lease.js";
import type { RunningLease } from "../../src/run/run-lease.js";
import { loadStoredManifest } from "../../src/store/envelope.js";
import { main } from "../../src/program.js";
import { NOW, createHarness, delegatedManifest, writeSignedManifest } from "./cli-harness.js";
import type { Harness } from "./cli-harness.js";
import { startPublisherStub } from "./publisher-stub.js";
import type { PublisherStub } from "./publisher-stub.js";

export const PAYSTACK = "paystack.transactions";
export const SHEETS = "sheets.orders";
export const VERIFIER_PREDICATE = "count(rows where status = 'reconciled') >= 1";

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface ApiMock {
  readonly url: string;
  readonly hits: RecordedRequest[];
  readonly stop: () => Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += (chunk as Buffer).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** A loopback JSON "customer API": records every request and answers with `respond(body)`. */
export async function startApiMock(
  respond: (body: Record<string, unknown>) => unknown,
): Promise<ApiMock> {
  const hits: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void readJson(req).then((body) => {
      hits.push({
        url: req.url ?? "",
        method: req.method ?? "",
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(respond(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/api`,
    hits,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface HybridFixture {
  readonly harness: Harness;
  /** Deps with a MUTABLE clock: set `time.now` to move time. */
  readonly deps: CliDeps;
  readonly time: { now: number };
  readonly leaseId: string;
  readonly verified: VerifiedManifest;
  readonly profile: RunProfile;
  readonly credentials: Record<string, SeededCredential>;
  readonly mock: MockAuthHarness;
  readonly publisher: PublisherStub;
  readonly paystack: ApiMock;
  readonly sheets: ApiMock;
  /** Every URL the outbound connector actually called (after the endpoints mapping). */
  readonly outboundUrls: string[];
  readonly outboundFetch: FetchLike;
  readonly licenseIssuer: LicenseIssuerClient;
  /** Rows the sheets mock currently holds. */
  readonly rows: Array<Record<string, unknown>>;
  readonly start: (options?: { readonly withIssuer?: boolean }) => Promise<Live>;
  readonly stop: () => Promise<void>;
}

export interface Live {
  readonly client: Client;
  readonly running: RunningLease;
}

export async function createHybridFixture(
  options: { readonly cleanupHook?: boolean } = {},
): Promise<HybridFixture> {
  const harness = await createHarness();
  const mock = await startMockAuthServer();
  const publisher = await startPublisherStub();
  const rows: Array<Record<string, unknown>> = [];
  const paystack = await startApiMock(() => ({ transactions: [{ id: "t1", amount: 1000 }] }));
  const sheets = await startApiMock((body) => {
    if (typeof body.order_id === "string")
      rows.push({ order: body.order_id, status: "reconciled" });
    return { rows };
  });

  const manifest: Manifest = delegatedManifest({
    job: {
      description: "Reconcile paystack transactions against the order sheet.",
      verifier: { type: "resource_query", resource: SHEETS, predicate: VERIFIER_PREDICATE },
    },
    scopes: [
      { resource: PAYSTACK, access: ["read"] },
      { resource: SHEETS, access: ["read", "write"] },
    ],
    auth: {
      delegated: [
        { provider: "paystack", resources: [PAYSTACK] },
        { provider: "google", resources: [SHEETS] },
      ],
      hosted: { license_issuer: "pub.example", kid: "k1" },
    },
    cleanup:
      options.cleanupHook === true
        ? { hook: { url: `${publisher.baseUrl}/alp/cleanup` }, publisher_retains: "aggregates" }
        : null,
  });
  const signed = await writeSignedManifest(harness.root, manifest);
  await writeFile(path.join(harness.root, "trust.json"), signed.trustJson);
  const bindingFile = await publisher.writeBindingFile(harness.root);
  const code = await main(
    ["--store", harness.root, "create", signed.manifestPath, "--publisher", bindingFile],
    harness.deps,
  );
  if (code !== 0)
    throw new Error(`fixture: create exited ${String(code)}: ${harness.stderr.join("")}`);
  const leaseId = harness.stdout.join("").trim();
  harness.stdout.length = 0;
  harness.stderr.length = 0;

  const time = { now: NOW };
  const deps: CliDeps = { ...harness.deps, clock: () => time.now };

  const readTool = (
    name: string,
  ): { name: string; description: string; inputSchema: { type: "object" } } => ({
    name,
    description: name,
    inputSchema: { type: "object" },
  });
  const binding = (
    tool: string,
    resource: string,
    access: ConnectorBinding["access"],
    extra: Partial<ConnectorBinding> = {},
  ): ConnectorBinding => ({
    tool,
    resource,
    access,
    irreversible: false,
    provenance: "built_in",
    ...extra,
  });
  const profile: RunProfile = {
    catalog: createToolCatalog([
      readTool("list_transactions"),
      readTool("list_orders"),
      {
        name: "mark_order_reconciled",
        description: "Marks an order reconciled",
        inputSchema: {
          type: "object",
          properties: { order_id: { type: "string" } },
          required: ["order_id"],
        },
      },
    ]),
    bindings: createBindingSet([
      binding("list_transactions", PAYSTACK, "read"),
      binding("list_orders", SHEETS, "read", {
        rowAdapter: (result) => {
          const body = result.body as { rows?: Array<Record<string, unknown>> };
          return { rows: body.rows ?? [] };
        },
      }),
      binding("mark_order_reconciled", SHEETS, "write"),
    ]),
    oauth: mock.oauthClient,
    endpoints: { [PAYSTACK]: paystack.url, [SHEETS]: sheets.url },
  };

  const tokenEndpoint = mock.oauthClient.as.token_endpoint ?? "";
  const seed = (resource: string): SeededCredential => ({
    accessToken: `seed-access-${resource}`,
    refreshToken: `seed-refresh-${resource}`,
    expiry: NOW - 10, // expired: the first call refreshes over the loopback AS
    tokenEndpoint,
    resourceIndicator: `https://api.example.test/${resource}`,
  });
  const credentials = { [PAYSTACK]: seed(PAYSTACK), [SHEETS]: seed(SHEETS) };

  const outboundUrls: string[] = [];
  const outboundFetch: FetchLike = (url, init) => {
    outboundUrls.push(url);
    return fetch(url, init);
  };

  const licenseIssuer = createLicenseIssuerClient({
    publicKey: await importLicensePublicKey(publisher.binding.license_public_key),
    specVersion: manifest.spec_version,
    transport: httpIssuerTransport(publisher.binding),
  });

  const verified = await loadStoredManifest(deps, harness.root, leaseId);
  const lives: Client[] = [];

  const start = async (startOptions: { readonly withIssuer?: boolean } = {}): Promise<Live> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const running = await runLease({
      leaseId,
      root: harness.root,
      transport: serverTransport,
      adapter: deps.adapterFactory(deps.io, { json: false }),
      deps,
      verified,
      profile,
      credentials,
      outboundFetch,
      ...(startOptions.withIssuer === true ? { licenseIssuer } : {}),
    });
    const client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(clientTransport);
    lives.push(client);
    return { client, running };
  };

  return {
    harness,
    deps,
    time,
    leaseId,
    verified,
    profile,
    credentials,
    mock,
    publisher,
    paystack,
    sheets,
    outboundUrls,
    outboundFetch,
    licenseIssuer,
    rows,
    start,
    stop: async () => {
      for (const client of lives.splice(0)) await client.close();
      await Promise.all([mock.stop(), publisher.stop(), paystack.stop(), sheets.stop()]);
      await harness.cleanup();
    },
  };
}
