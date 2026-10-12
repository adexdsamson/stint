// Worker for the real killed-process proof (supervise-crash-resume.test.ts, SUP-03).
//
//   node supervise-crash-worker.mjs <root> <staleMs>
//
// Imports the BUILT cli dist and the built @stint/runtime (Node cannot resolve
// the repo's `.js`-suffixed TypeScript specifiers from src/). Build runtime and
// cli first.
//
// Runs ONE supervisor sweep (`runSweep`) over the real JSON stores under <root>
// with the real wall clock. Every teardown step appends its name to
// <root>/steps.log just before it runs. When step 3 (`cleanup_hook`) starts it
// prints `BLOCKED` and never settles, so the test can kill this process in the
// middle of a teardown with the fence held and steps 1 and 2 already recorded.
// Prints nothing else: no lease content, no secret, no key material, no error text.

import { appendFileSync } from "node:fs";
import path from "node:path";

import { runSweep } from "@stint/runtime";

import {
  buildRuntimePorts,
  createJsonLeaseStore,
  createJsonReceiptStore,
  loadCheckpointPublicKey,
  loadOrCreateRuntimeKey,
  loadTrustStore,
} from "../../dist/index.js";

const [root, staleArg] = process.argv.slice(2);
const staleMs = Number(staleArg);

if (!root || !Number.isFinite(staleMs)) {
  console.error("usage: supervise-crash-worker.mjs <root> <staleMs>");
  process.exit(2);
}

const logFile = path.join(root, "steps.log");

try {
  const ports = buildRuntimePorts(
    {
      clock: () => Math.floor(Date.now() / 1000),
      storeFactory: (r) => createJsonLeaseStore({ root: r, staleMs }),
      receiptStoreFactory: (r, leaseId) => createJsonReceiptStore({ root: r, leaseId }),
      keys: { loadOrCreate: loadOrCreateRuntimeKey, loadPublic: loadCheckpointPublicKey },
      loadTrustStore,
    },
    root,
  );

  await runSweep(ports, {
    decorateSteps: (steps) =>
      steps.map((inner) => ({
        name: inner.name,
        async run(lease, now) {
          appendFileSync(logFile, `${inner.name}\n`);
          if (inner.name === "cleanup_hook") {
            process.stdout.write("BLOCKED\n");
            // Keep the event loop alive so the process waits here to be killed.
            setInterval(() => undefined, 1 << 30);
            await new Promise(() => undefined);
          }
          return inner.run(lease, now);
        },
      })),
  });
  // Reaching here means the sweep finished without being killed: the test treats that as a failure.
  process.stdout.write("DONE\n");
  process.exit(0);
} catch {
  // The message is deliberately not printed: it could name a path or a lease.
  process.stdout.write("ERROR\n");
  process.exit(1);
}
