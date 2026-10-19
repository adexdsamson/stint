// THROWAWAY spike (never merges): drives the REAL @napi-rs/keyring binding.
// Sections: A1 (prebuilt install + addon load), probe (A7 availability round trip),
// contract-shaped exercise (chunked 10k value, 20 concurrent writes, prefix delete).
import { createRequire } from "node:module";
import { readdirSync, appendFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { chunkUtf8, createKeychainSecretStore, sha256, CHUNK_BYTES } from "./store.mjs";

const results = [];
async function section(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`PASS ${name} (${Date.now() - t0}ms)`, detail ?? "");
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(err?.stack ?? err) });
    console.log(`FAIL ${name} (${Date.now() - t0}ms)\n${err?.stack ?? err}`);
  }
}

console.log(`platform=${process.platform} arch=${process.arch} node=${process.version} os=${os.type()} ${os.release()}`);

// ---- A1: prebuilt platform package resolves and the addon loads ----
const require = createRequire(import.meta.url);
let keyring;
await section("A1 prebuilt-resolves-and-loads", async () => {
  const main = require.resolve("@napi-rs/keyring");
  const scopeDir = path.resolve(path.dirname(main), "..");
  // pnpm keeps platform packages as siblings in .pnpm; list what is next to the main package.
  const siblings = readdirSync(scopeDir).filter((n) => n.startsWith("keyring"));
  console.log("  @napi-rs siblings:", siblings.join(", "));
  const platformPkg = siblings.find((n) => n.includes(process.platform) && (n.includes(process.arch) || process.platform === "darwin"));
  assert.ok(platformPkg, `no ${process.platform}/${process.arch} prebuilt package beside @napi-rs/keyring (saw: ${siblings.join(", ")})`);
  keyring = await import("@napi-rs/keyring");
  assert.equal(typeof keyring.AsyncEntry, "function");
  assert.equal(typeof keyring.findCredentialsAsync, "function");
  return { platformPkg, exports: Object.keys(keyring).sort() };
});
if (!keyring) {
  summarize();
  process.exit(1);
}

const entryOptions = { linux: { store: "secret-service" } };

// ---- A7 / availability probe: set -> get -> assert -> delete ----
await section("PROBE set/get/delete round trip", async () => {
  const e = new keyring.AsyncEntry(`stint-spike-probe-${randomUUID()}`, "probe-account", entryOptions);
  await e.setPassword("probe-value");
  assert.equal(await e.getPassword(), "probe-value");
  assert.equal(await e.deletePassword(), true);
  assert.equal(await e.getPassword(), null);
});

// ---- informational: how big a single keychain entry can this backend hold? ----
await section("INFO single-entry size limits (informational)", async () => {
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
});

function makeValue() {
  // Multi-byte content on purpose: 2-, 3- and 4-byte UTF-8 sequences plus newlines.
  const unit = "héllo 世界 😀\nline ";
  let v = "";
  while (v.length < 10_000) v += unit + randomBytes(3).toString("hex") + " ";
  return v.slice(0, 10_000).replace(/[\uD800-\uDBFF]$/, "");
}

const service = `stint-spike-${randomUUID()}`;
const store = createKeychainSecretStore({ service, keyring, entryOptions });

await section(`CONTRACT 10k value chunked <=${CHUNK_BYTES}B, sha256 byte-identical`, async () => {
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
  return { chars: value.length, bytes: Buffer.byteLength(value, "utf8"), chunks: chunks.length };
});

await section("CONTRACT 20 concurrent chunked puts to one key leave exactly one value", async () => {
  const key = "lease/spike-2/cred/sheets";
  const values = Array.from({ length: 20 }, (_, i) => `writer-${i}:` + makeValue());
  await Promise.all(values.map((v) => store.put(key, v)));
  const final = await store.get(key);
  assert.ok(values.includes(final), "final value is not byte-identical to any single written value (mixed chunks?)");
  const orphansBeforeSweep = (await store.listAccounts()).filter((a) => a.startsWith(`C:${key}:`)).length;
  const swept = await store.sweepOrphans(key);
  const head = JSON.parse(await new keyring.AsyncEntry(service, `H:${key}`, entryOptions).getPassword());
  const remaining = (await store.listAccounts()).filter((a) => a.startsWith(`C:${key}:`)).length;
  assert.equal(remaining, head.n, "after sweep only the winning generation's chunks may remain");
  assert.equal(await store.get(key), final);
  await store.delete(key);
  return { winner: final.slice(0, 9), chunkEntriesBeforeSweep: orphansBeforeSweep, swept, remainingAfterSweep: remaining };
});

await section("CONTRACT raw 20 concurrent setPassword on ONE entry leave exactly one value", async () => {
  const e = () => new keyring.AsyncEntry(service, "raw-concurrent", entryOptions);
  const values = Array.from({ length: 20 }, (_, i) => `raw-${i}-${"z".repeat(1500)}`);
  await Promise.all(values.map((v) => e().setPassword(v)));
  const final = await e().getPassword();
  assert.ok(values.includes(final));
  await e().deletePassword();
});

await section("CONTRACT prefix delete removes only its own segment", async () => {
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
});

await section("INFO findCredentialsAsync enumerates by service (informational)", async () => {
  await store.put("lease/enum/cred/a", "1");
  const accounts = await store.listAccounts();
  assert.ok(accounts.some((a) => a === "H:lease/enum/cred/a"));
  await store.deletePrefix("lease/enum/");
  return { sawAccounts: accounts.length };
});

function summarize() {
  const lines = [
    `### keychain spike: ${process.platform}/${process.arch}`,
    "",
    "| result | section | ms |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.ms} |`),
    "",
    "```json",
    JSON.stringify(results, null, 2),
    "```",
  ];
  console.log("SPIKE-RESULT " + JSON.stringify({ platform: process.platform, arch: process.arch, results }));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

summarize();
process.exit(results.every((r) => r.ok) ? 0 : 1);
