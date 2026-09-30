/**
 * Manual-UAT setup for Phase 6 Test 1 (real-terminal consent + run approvals).
 *
 * Builds a self-contained store dir with a SIGNED manifest, a matching trust
 * store, a run profile, and a credentials file — the same shapes the automated
 * tests use — so you can drive the REAL `stint` binary on a REAL console.
 *
 * Run from packages/cli:  node manual/setup.mjs
 * It prints the exact commands to run next.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { signManifestForTest } from "@stint/spec/testing";

const ORDERS = "sheets.orders";
const NOW = Math.floor(Date.now() / 1000);

// Delegated manifest whose scopes/approvals match the run profile below.
// approvals.timeout_seconds = 15 keeps the run "no-answer" test short.
const manifest = {
  spec_version: "alp/0.1",
  agent: { id: "reconciler", name: "Order Reconciler", description: "Reconciles orders." },
  publisher: { id: "pub.example", name: "Pub Example" },
  version: "1.0.0",
  job: { description: "Reconcile the order sheet.", verifier: { type: "none" } },
  scopes: [{ resource: ORDERS, access: ["read", "send"] }],
  lease: { max_duration_seconds: 3600 },
  limits: { max_actions: 25, actions_per_hour: 10 },
  approvals: { require_for: ["send"], timeout_seconds: 15 },
  auth: { mode: "delegated", delegated: [{ provider: "google", resources: [ORDERS] }] },
  cleanup: null,
};

const profile = {
  catalog: [
    { name: "read_orders", description: "Reads the order sheet", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "send_notice", description: "Sends a notice", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: [] } },
  ],
  bindings: [
    { tool: "read_orders", resource: ORDERS, access: "read", irreversible: false, provenance: "built_in" },
    { tool: "send_notice", resource: ORDERS, access: "send", irreversible: false, provenance: "built_in" },
  ],
  oauth: {
    as: { issuer: "https://as.example.test", token_endpoint: "https://as.example.test/token" },
    client_id: "stint-test-client",
    auth_method: "none",
  },
};

const credentials = {
  [ORDERS]: {
    accessToken: "access-token-secret-do-not-leak",
    refreshToken: "refresh-token-secret-do-not-leak",
    expiry: NOW + 3600,
    tokenEndpoint: "https://as.example.test/token",
    resourceIndicator: "https://api.example.test/orders",
  },
};

const store = await mkdtemp(path.join(os.tmpdir(), "stint-uat-"));
const { envelope, publicJwk } = await signManifestForTest(manifest, { kid: "k1" });
const manifestPath = path.join(store, "manifest.json");

await writeFile(manifestPath, JSON.stringify(envelope));
await writeFile(path.join(store, "trust.json"), JSON.stringify({ [manifest.publisher.id]: { k1: publicJwk } }));
await writeFile(path.join(store, "profile.json"), JSON.stringify(profile));
await writeFile(path.join(store, "credentials.json"), JSON.stringify(credentials));

const q = (p) => (p.includes(" ") ? `"${p}"` : p);
console.log(`
Store ready:  ${store}

# 1) CONSENT prompt (run 3x — answer y, then n, then nothing/Ctrl-C-wait):
node dist/bin.js --store ${q(store)} create ${q(manifestPath)}
#   y  -> prints a lease id, lease becomes ACTIVE
#   n  -> "declined", exit 3
#   (no answer) -> denied on consent timeout (~120s), exit 3

# 2) RUN approval prompt — needs an ACTIVE lease id from a 'y' create above.
#    Export it, then drive a gated call with the MCP client (answer y / n / nothing):
#   PowerShell:  $env:STINT_STORE=${q(store)}; $env:STINT_LEASE="<leaseId>"
#   Git Bash:    export STINT_STORE=${q(store)} STINT_LEASE="<leaseId>"
node manual/mcp-call.mjs
#   y  -> tool call executes (client prints {"rows":3}-style result)
#   n  -> call denied (user_denied), downstream never hit
#   (no answer) -> denied after 15s (approvals.timeout_seconds)
`);
