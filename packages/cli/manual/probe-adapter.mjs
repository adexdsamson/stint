/**
 * High-fidelity repro of the consent prompt using the REAL built adapter,
 * driven exactly as create.ts drives it (awaitConsentDecision + 120s abort).
 * Run in a real console:  node manual/probe-adapter.mjs
 * Type y then Enter. If it returns before you type, the adapter path is the bug.
 */
import { createTerminalHostAdapter, createStyle } from "../dist/index.js";
import { awaitConsentDecision } from "@stint/core";

const clock = () => Math.floor(Date.now() / 1000);

const adapter = createTerminalHostAdapter({
  input: process.stdin,
  output: process.stdout,
  approvalTimeoutSeconds: 60,
  clock,
  style: createStyle(false),
});

// Minimal ConsentRequest shape: requestConsent reads request.manifest.manifest.
const manifest = {
  spec_version: "alp/0.1",
  agent: { id: "a", name: "Probe Agent", description: "x" },
  publisher: { id: "p", name: "Probe Pub" },
  version: "1.0.0",
  job: { description: "probe", verifier: { type: "none" } },
  scopes: [{ resource: "sheets.orders", access: ["read"] }],
  lease: { max_duration_seconds: 3600 },
  limits: { max_actions: 1, actions_per_hour: 1 },
  approvals: { require_for: [], timeout_seconds: 60 },
  auth: { mode: "delegated", delegated: [{ provider: "google", resources: ["sheets.orders"] }] },
  cleanup: null,
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 120_000);
console.log("node", process.version, "stdin.isTTY", process.stdin.isTTY, "\n--- type y then Enter ---");
const t0 = Date.now();
try {
  const decision = await awaitConsentDecision(
    adapter,
    { consentId: "probe", manifest: { manifest } },
    controller.signal,
  );
  console.log(`\n-> decision: ${JSON.stringify(decision)}  (after ${Date.now() - t0}ms)`);
  if (Date.now() - t0 < 500) console.log("   <-- BUG: resolved immediately without waiting for input");
} finally {
  clearTimeout(timer);
  controller.abort();
}
process.exit(0);
