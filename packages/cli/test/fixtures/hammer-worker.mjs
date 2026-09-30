// Worker for the cross-process HOST-03 hammer (json-store-concurrency.test.ts).
//
//   node hammer-worker.mjs <root> <leaseId> <mode> <n>
//
// Imports the BUILT dist (not src/): Node cannot resolve the repo's
// `.js`-suffixed TypeScript specifiers from src/. Run `pnpm build` first (the
// root `pnpm test` does).
//
// writer: performs <n> version-bump transactions.
// reader: loops load()/list() until <root>/reader-stop exists, counting torn reads.
// Prints ONE JSON summary line on stdout; exits non-zero on any non-transient
// error. Transient EPERM/EBUSY/EACCES are absorbed inside the store's retry
// budget. Nothing lease- or receipt-shaped beyond counters is ever printed.

import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createJsonLeaseStore } from "../../dist/index.js";

const [root, id, mode, nRaw] = process.argv.slice(2);
const n = Number(nRaw);

if (!root || !id || (mode !== "writer" && mode !== "reader") || !Number.isInteger(n)) {
  console.error("usage: hammer-worker.mjs <root> <leaseId> <writer|reader> <n>");
  process.exit(2);
}

const store = createJsonLeaseStore({ root });
const summary = { mode, done: 0, parseErrors: 0, otherErrors: 0 };

try {
  if (mode === "writer") {
    for (let i = 0; i < n; i++) {
      await store.transaction(id, (lease) => ({ ...lease, version: lease.version + 1 }));
      summary.done++;
    }
  } else {
    const stopFile = path.join(root, "reader-stop");
    let lastVersion = -1;
    while (!existsSync(stopFile)) {
      try {
        const lease = await store.load(id);
        await store.list();
        if (lease === undefined || lease.version < lastVersion) {
          summary.otherErrors++; // a vanished lease or a version going backwards
        } else {
          lastVersion = lease.version;
        }
        summary.done++;
      } catch (e) {
        if (e instanceof Error && e.name === "StoreCorruptError") summary.parseErrors++;
        else summary.otherErrors++;
      }
      await sleep(2);
    }
  }
} catch {
  summary.otherErrors++;
}

console.log(JSON.stringify(summary));
process.exit(summary.parseErrors > 0 || summary.otherErrors > 0 ? 1 : 0);
