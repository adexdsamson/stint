// Worker for the cross-process teardown race (teardown-concurrent.test.ts, TEAR-06).
//
//   node teardown-worker.mjs <root> <leaseId> <failStep|-> <jwkPath>
//
// Imports the BUILT cli dist and the built @stint/proxy (Node cannot resolve
// the repo's `.js`-suffixed TypeScript specifiers from src/). Build cli and
// proxy first.
//
// Drives `runTeardown` on one lease over the real JSON stores. Every step run
// appends one line with the step name to <root>/steps.log (append-mode write,
// atomic for a short line), and <failStep> (when not "-") always resolves
// `failed`. Prints ONE JSON summary line (final lease state only) and exits 0,
// or exits 1 on any thrown error. Nothing lease-shaped beyond the state name,
// and no key material, is ever printed.

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { createDefaultTeardownSteps, runTeardown } from "@stint/proxy";
import { importJWK } from "jose";

import { createJsonLeaseStore, createJsonReceiptStore } from "../../dist/index.js";

const [root, leaseId, failStepArg, jwkPath] = process.argv.slice(2);

if (!root || !leaseId || !failStepArg || !jwkPath) {
  console.error("usage: teardown-worker.mjs <root> <leaseId> <failStep|-> <jwkPath>");
  process.exit(2);
}

const failStep = failStepArg === "-" ? undefined : failStepArg;
const logFile = path.join(root, "steps.log");

try {
  const signingKey = await importJWK(JSON.parse(readFileSync(jwkPath, "utf8")), "EdDSA");
  const leaseStore = createJsonLeaseStore({ root });
  const receiptStore = createJsonReceiptStore({ root, leaseId });

  const steps = createDefaultTeardownSteps(receiptStore, signingKey).map((inner) => ({
    name: inner.name,
    async run(lease, now) {
      appendFileSync(logFile, `${inner.name}\n`);
      if (inner.name === failStep) return "failed";
      return inner.run(lease, now);
    },
  }));

  const finished = await runTeardown({ leaseStore, receiptStore, leaseId, steps, signingKey }, Math.floor(Date.now() / 1000));
  console.log(JSON.stringify({ state: finished.state }));
  process.exit(0);
} catch {
  // The message is deliberately not printed: it could name a path or a lease.
  console.log(JSON.stringify({ error: true }));
  process.exit(1);
}
