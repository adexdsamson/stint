// THROWAWAY spike (never merges): a chunked SecretStore over @napi-rs/keyring.
//
// Layout in the OS keychain (service = one per store):
//   head   account  H:<key>                  -> JSON { gen, n, bytes, sha256 }
//   chunk  account  C:<key>:<gen>:<i>        -> <= CHUNK_BYTES of UTF-8 text
// put writes the chunks under a fresh generation, then flips the head last, so
// a concurrent reader sees either the old or the new value, never a mix.
import { createHash, randomUUID } from "node:crypto";

export const CHUNK_BYTES = Number(process.env.CHUNK_BYTES ?? 2048);

/** Split a string into pieces of <= max UTF-8 bytes without splitting a code point. */
export function chunkUtf8(text, max = CHUNK_BYTES) {
  const out = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curBytes + b > max) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export function createKeychainSecretStore({
  service,
  keyring,
  validateKey = () => {},
  validatePrefix = () => {},
  entryOptions = { linux: { store: "secret-service" } },
  serialize = false,
}) {
  const { AsyncEntry, findCredentialsAsync } = keyring;
  // serialize=true funnels EVERY native keychain call through one in-process FIFO
  // queue (the mitigation under test for concurrent-write failures on macOS).
  let tail = Promise.resolve();
  const gate = (fn) => {
    if (!serialize) return fn();
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
  const entry = (account) => {
    const e = new AsyncEntry(service, account, entryOptions);
    return {
      setPassword: (v) => gate(() => e.setPassword(v)),
      getPassword: () => gate(() => e.getPassword()),
      deletePassword: () => gate(() => e.deletePassword()),
    };
  };
  const list = async () => (await gate(() => findCredentialsAsync(service))).map((c) => c.account);

  async function readHead(key) {
    const raw = await entry(`H:${key}`).getPassword();
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  }

  async function deleteChunks(key, head) {
    await Promise.all(
      Array.from({ length: head.n }, (_, i) => entry(`C:${key}:${head.gen}:${i}`).deletePassword()),
    );
  }

  return {
    async get(key) {
      validateKey(key);
      for (let attempt = 0; attempt < 5; attempt++) {
        const head = await readHead(key);
        if (!head) return undefined;
        const parts = await Promise.all(
          Array.from({ length: head.n }, (_, i) => entry(`C:${key}:${head.gen}:${i}`).getPassword()),
        );
        if (parts.some((p) => p === null || p === undefined)) continue; // replaced under us: re-read head
        const value = parts.join("");
        if (sha256(value) !== head.sha256) throw new Error(`checksum mismatch for ${key}`);
        return value;
      }
      throw new Error(`could not read a stable value for ${key}`);
    },

    async put(key, value) {
      validateKey(key);
      const chunks = chunkUtf8(value);
      const gen = randomUUID();
      await Promise.all(chunks.map((c, i) => entry(`C:${key}:${gen}:${i}`).setPassword(c)));
      const old = await readHead(key);
      const head = { gen, n: chunks.length, bytes: Buffer.byteLength(value, "utf8"), sha256: sha256(value) };
      await entry(`H:${key}`).setPassword(JSON.stringify(head));
      if (old) await deleteChunks(key, old);
    },

    async delete(key) {
      validateKey(key);
      const head = await readHead(key);
      if (!head) return;
      await entry(`H:${key}`).deletePassword();
      await deleteChunks(key, head);
    },

    async deletePrefix(prefix) {
      validatePrefix(prefix);
      const accounts = await list();
      let removed = 0;
      for (const account of accounts) {
        if (account.startsWith(`H:${prefix}`)) {
          await entry(account).deletePassword();
          removed += 1;
        }
      }
      for (const account of accounts) {
        if (account.startsWith(`C:${prefix}`)) await entry(account).deletePassword();
      }
      return removed;
    },

    /** Remove chunk generations that no head points at (left by racing puts). Returns the count removed. */
    async sweepOrphans(key) {
      const head = await readHead(key);
      const keepPrefix = head ? `C:${key}:${head.gen}:` : undefined;
      let removed = 0;
      for (const account of await list()) {
        if (account.startsWith(`C:${key}:`) && !(keepPrefix && account.startsWith(keepPrefix))) {
          await entry(account).deletePassword();
          removed += 1;
        }
      }
      return removed;
    },

    listAccounts: list,
  };
}
