/**
 * Shared rig for the `stint run` tests: a real, ACTIVE lease created through
 * `stint create` on a temp store (so the signed envelope is persisted exactly
 * as production does), plus a run profile, a credentials file, a fake
 * downstream `fetch`, and a fake-TTY terminal adapter.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { FetchLike } from "@stint/proxy";
import type { VerifiedManifest } from "@stint/spec";
import type { SeededCredential } from "@stint/proxy";

import { createTerminalHostAdapter } from "../../src/adapter/terminal-host-adapter.js";
import { main } from "../../src/program.js";
import { parseRunProfile } from "../../src/run/profile.js";
import type { RunProfile } from "../../src/run/profile.js";
import { loadStoredManifest } from "../../src/store/envelope.js";
import { NOW, createHarness, delegatedManifest, writeSignedManifest } from "./cli-harness.js";
import type { Harness } from "./cli-harness.js";

export const ORDERS = "sheets.orders";
export const ACCESS_TOKEN = "access-token-secret-do-not-leak";

export const PROFILE_JSON = {
  catalog: [
    {
      name: "read_orders",
      description: "Reads the order sheet",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "send_notice",
      description: "Sends a notice",
      inputSchema: { type: "object", properties: { to: { type: "string" } }, required: [] },
    },
  ],
  bindings: [
    {
      tool: "read_orders",
      resource: ORDERS,
      access: "read",
      irreversible: false,
      provenance: "built_in",
    },
    {
      tool: "send_notice",
      resource: ORDERS,
      access: "send",
      irreversible: false,
      provenance: "built_in",
    },
  ],
  oauth: {
    as: { issuer: "https://as.example.test", token_endpoint: "https://as.example.test/token" },
    client_id: "stint-test-client",
    auth_method: "none",
  },
} as const;

export const CREDENTIALS_JSON: Record<string, SeededCredential> = {
  [ORDERS]: {
    accessToken: ACCESS_TOKEN,
    refreshToken: "refresh-token-secret-do-not-leak",
    expiry: NOW + 3600,
    tokenEndpoint: "https://as.example.test/token",
    resourceIndicator: "https://api.example.test/orders",
  },
};

export interface RunFixture {
  readonly harness: Harness;
  readonly leaseId: string;
  readonly verified: VerifiedManifest;
  readonly profile: RunProfile;
  readonly profilePath: string;
  readonly credentialsPath: string;
  readonly credentials: Record<string, SeededCredential>;
  /** Every downstream request the (fake) outbound `fetch` saw. */
  readonly fetchCalls: Array<{ readonly url: string; readonly authorization: string | null }>;
  readonly outboundFetch: FetchLike;
}

export async function createRunFixture(
  options: { readonly approvalTimeoutSeconds?: number } = {},
): Promise<RunFixture> {
  const harness = await createHarness();
  const manifest = delegatedManifest({
    scopes: [{ resource: ORDERS, access: ["read", "send"] }],
    approvals: { require_for: ["send"], timeout_seconds: options.approvalTimeoutSeconds ?? 60 },
    auth: { mode: "delegated", delegated: [{ provider: "google", resources: [ORDERS] }] },
  });
  const fixture = await writeSignedManifest(harness.root, manifest);
  await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);

  const code = await main(["--store", harness.root, "create", fixture.manifestPath], harness.deps);
  if (code !== 0)
    throw new Error(`fixture: create exited ${String(code)}: ${harness.stderr.join("")}`);
  const leaseId = harness.stdout.join("").trim();
  harness.stdout.length = 0;
  harness.stderr.length = 0;

  const profilePath = path.join(harness.root, "profile.json");
  const credentialsPath = path.join(harness.root, "credentials.json");
  await writeFile(profilePath, JSON.stringify(PROFILE_JSON));
  await writeFile(credentialsPath, JSON.stringify(CREDENTIALS_JSON));

  const fetchCalls: RunFixture["fetchCalls"] = [];
  const outboundFetch: FetchLike = (url, init) => {
    const headers = new Headers(init?.headers);
    fetchCalls.push({ url, authorization: headers.get("authorization") });
    return Promise.resolve(new Response(JSON.stringify({ rows: 3 }), { status: 200 }));
  };

  return {
    harness,
    leaseId,
    verified: await loadStoredManifest(harness.deps, harness.root, leaseId),
    profile: parseRunProfile(PROFILE_JSON),
    profilePath,
    credentialsPath,
    credentials: CREDENTIALS_JSON,
    fetchCalls,
    outboundFetch,
  };
}

export interface TerminalRig {
  readonly input: PassThrough & { isTTY?: boolean };
  readonly adapter: ReturnType<typeof createTerminalHostAdapter>;
  readonly outText: () => string;
  readonly errText: () => string;
  readonly waitFor: (text: string) => Promise<void>;
}

/** A terminal `HostAdapter` over FAKED TTY streams (`isTTY` on the input; plain-line readline mode). */
export function terminalRig(
  options: { tty?: boolean; approvalTimeoutSeconds?: number } = {},
): TerminalRig {
  const input = Object.assign(new PassThrough(), { isTTY: options.tty ?? true });
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let out = "";
  let err = "";
  output.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  errorOutput.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const adapter = createTerminalHostAdapter({
    input,
    output,
    errorOutput,
    approvalTimeoutSeconds: options.approvalTimeoutSeconds ?? 60,
    clock: () => NOW,
    terminal: false,
  });
  const waitFor = async (text: string): Promise<void> => {
    for (let i = 0; i < 400 && !out.includes(text); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!out.includes(text)) throw new Error(`prompt "${text}" never appeared; output: ${out}`);
  };
  return { input, adapter, outText: () => out, errText: () => err, waitFor };
}
