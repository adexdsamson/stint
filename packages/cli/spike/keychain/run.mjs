// THROWAWAY spike (never merges): drives the REAL @napi-rs/keyring binding.
// Usage: node run.mjs <section>   (driver.mjs runs each section in its own killable process)
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { chunkUtf8, createKeychainSecretStore, sha256, CHUNK_BYTES } from "./store.mjs";

const require = createRequire(import.meta.url);
const entryOptions = { linux: { store: "secret-service" } };

function makeValue() {
  // Multi-byte content on purpose: 2-, 3- and 4-byte UTF-8 sequences plus newlines.
  const unit = "héllo 世界 😀\nline ";
  let v = "";
  while (v.length < 10_000) v += unit + randomBytes(3).toString("hex") + " ";
  return v.slice(0, 10_000).replace(/[\uD800-\uDBFF]$/, "");
}

async function load() {
  const main = require.resolve("@napi-rs/keyring");
  const scopeDir = path.resolve(path.dirname(main), "..");
  const siblings = readdirSync(scopeDir).filter((n) => n.startsWith("keyring"));
  const platformPkg = siblings.find(
    (n) => n.includes(process.platform) && (n.includes(process.arch) || process.platform === "darwin"),
  );
  assert.ok(platformPkg, `no ${process.platform}/${process.arch} prebuilt beside @napi-rs/keyring (saw: ${siblings.join(", ")})`);
  const keyring = await import("@napi-rs/keyring");
  assert.equal(typeof keyring.AsyncEntry, "function");
  assert.equal(typeof keyring.findCredentialsAsync, "function");
  return { keyring, info: { platformPkg, siblings, exports: Object.keys(keyring).sort() } };
}

async function concurrentChunked(serialize) {
  const { keyring } = await load();
  const service = `stint-spike-${randomUUID()}`;
  const store = createKeychainSecretStore({ service, keyring, entryOptions, serialize });
  const key = "lease/spike-2/cred/sheets";
  const values = Array.from({ length: 20 }, (_, i) => `writer-${i}:` + makeValue());
  await Promise.all(values.map((v) => store.put(key, v)));
  const final = await store.get(key);
  assert.ok(values.includes(final), "final value is not byte-identical to any single written value (mixed chunks?)");
  const before = (await store.listAccounts()).filter((a) => a.startsWith(`C:${key}:`)).length;
  const swept = await store.sweepOrphans(key);
  const head = JSON.parse(await new keyring.AsyncEntry(service, `H:${key}`, entryOptions).getPassword());
  const remaining = (await store.listAccounts()).filter((a) => a.startsWith(`C:${key}:`)).length;
  assert.equal(remaining, head.n, "after sweep only the winning generation's chunks may remain");
  assert.equal(await store.get(key), final);
  await store.delete(key);
  return { winner: final.slice(0, 9), chunkEntriesBeforeSweep: before, swept, remainingAfterSweep: remaining };
}

const sections = {
  async a1() {
    return (await load()).info;
  },

  async probe() {
    const { keyring } = await load();
    const e = new keyring.AsyncEntry(`stint-spike-probe-${randomUUID()}`, "probe-account", entryOptions);
    await e.setPassword("probe-value");
    assert.equal(await e.getPassword(), "probe-value");
    assert.equal(await e.deletePassword(), true);
    assert.equal(await e.getPassword(), null);
  },

  async sizes() {
    const { keyring } = await load();
    const outcome = {};
    for (const bytes of [1024, 2048, 4096, 16384, 65536]) {
      const e = new keyring.AsyncEntry(`stint-spike-size-${randomUUID()}`, "size", entryOptions);
      const v = "a".repeat(bytes);
      try {
        await e.setPassword(v);
        outcome[bytes] = (await e.getPassword()) === v ? "ok" : "readback-differs";
        await e.deletePassword();
      } catch (err) {
        outcome[bytes] = `error: ${String(err?.message ?? err).slice(0, 80)}`;
      }
    }
    return outcome;
  },

  async chunked10k() {
    const { keyring } = await load();
    const store = createKeychainSecretStore({ service: `stint-spike-${randomUUID()}`, keyring, entryOptions });
    const value = makeValue();
    const chunks = chunkUtf8(value);
    for (const c of chunks) assert.ok(Buffer.byteLength(c, "utf8") <= CHUNK_BYTES);
    assert.equal(chunks.join(""), value);
    const key = "lease/spike-1/cred/sheets";
    await store.put(key, value);
    const back = await store.get(key);
    assert.equal(sha256(back), sha256(value));
    assert.equal(Buffer.compare(Buffer.from(back, "utf8"), Buffer.from(value, "utf8")), 0);
    await store.delete(key);
    assert.equal(await store.get(key), undefined);
    return { chars: value.length, bytes: Buffer.byteLength(value, "utf8"), chunks: chunks.length, sha256: sha256(value).slice(0, 12) };
  },

  // ---- concurrency: unserialized (characterization) vs serialized (candidate design) ----
  async concChunkedUnserialized() {
    return concurrentChunked(false);
  },
  async concChunkedSerialized() {
    return concurrentChunked(true);
  },
  async concRawUnserialized() {
    const { keyring } = await load();
    const svc = `stint-spike-${randomUUID()}`;
    const e = () => new keyring.AsyncEntry(svc, "raw-concurrent", entryOptions);
    const values = Array.from({ length: 20 }, (_, i) => `raw-${i}-${"z".repeat(1500)}`);
    await Promise.all(values.map((v) => e().setPassword(v)));
    const final = await e().getPassword();
    assert.ok(values.includes(final));
    await e().deletePassword();
  },
  async concReadsUnserialized() {
    const { keyring } = await load();
    const svc = `stint-spike-${randomUUID()}`;
    const e = () => new keyring.AsyncEntry(svc, "raw-reads", entryOptions);
    await e().setPassword("read-me");
    const got = await Promise.all(Array.from({ length: 20 }, () => e().getPassword()));
    assert.ok(got.every((g) => g === "read-me"));
    await e().deletePassword();
  },

  async prefixDelete() {
    const { keyring } = await load();
    const store = createKeychainSecretStore({ service: `stint-spike-${randomUUID()}`, keyring, entryOptions });
    await store.put("lease/a/cred/x", "mine-1");
    await store.put("lease/a/cred/y", makeValue()); // multi-chunk
    await store.put("lease/ab/cred/x", "neighbour");
    const removed = await store.deletePrefix("lease/a/");
    assert.equal(removed, 2);
    assert.equal(await store.get("lease/a/cred/x"), undefined);
    assert.equal(await store.get("lease/a/cred/y"), undefined);
    assert.equal(await store.get("lease/ab/cred/x"), "neighbour");
    const leftover = (await store.listAccounts()).filter((a) => a.includes("lease/a/"));
    assert.deepEqual(leftover, [], "no chunk entries left behind under the deleted prefix");
    await store.deletePrefix("lease/ab/");
    return { removed };
  },

  async enumerate() {
    const { keyring } = await load();
    const store = createKeychainSecretStore({ service: `stint-spike-${randomUUID()}`, keyring, entryOptions });
    await store.put("lease/enum/cred/a", "1");
    const accounts = await store.listAccounts();
    assert.ok(accounts.includes("H:lease/enum/cred/a"));
    await store.deletePrefix("lease/enum/");
    return { sawAccounts: accounts.length };
  },
};

const name = process.argv[2];
if (!name || !(name in sections)) {
  console.error(`usage: node run.mjs <${Object.keys(sections).join("|")}>`);
  process.exit(2);
}
console.log(`[${name}] platform=${process.platform} arch=${process.arch} node=${process.version} os=${os.type()} ${os.release()}`);
const t0 = Date.now();
try {
  const detail = await sections[name]();
  console.log(`[${name}] PASS ${Date.now() - t0}ms ${detail === undefined ? "" : JSON.stringify(detail)}`);
  process.exit(0);
} catch (err) {
  console.log(`[${name}] FAIL ${Date.now() - t0}ms ${String(err?.stack ?? err).split("\n").slice(0, 4).join(" | ")}`);
  process.exit(1);
}
