/**
 * `@stint/core/testing` — the in-memory `LeaseStore` double and the reusable
 * `createLeaseStoreContractTests` suite factory (D-14), plus the in-memory
 * `ReceiptStore` double and `createReceiptStoreContractTests` suite factory
 * (D-08). This subpath is the ONLY place a `LeaseStore`/`ReceiptStore`
 * implementation is exercised generically: the public `.` entry
 * (`./index.ts`) never re-exports anything from this file, so production
 * code cannot accidentally depend on a test double.
 *
 * Phase 6's JSON-file `LeaseStore` (HOST-03, backed by `proper-lockfile` for
 * cross-process safety) imports `createLeaseStoreContractTests` and runs the
 * IDENTICAL suite against its own implementation, so the two stores cannot
 * silently drift from the per-lease serialization guarantee ALP.md Section 9
 * requires (D-13). Phase 6's JSON-file `ReceiptStore` likewise imports
 * `createReceiptStoreContractTests` and runs the IDENTICAL suite, so it
 * cannot silently drift from the in-memory double's append-only guarantee
 * (D-08).
 */

import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import type { PublicKey } from "paseto/v4/public";

import type { Checkpoint, ReceiptChain, ReceiptEntry } from "@stint/spec";

import type { Lease } from "./lease.js";
import type { LeaseMutator, LeaseScanEntry, LeaseStore } from "./lease-store.js";
import type { LicenseIssuer } from "./license/license-issuer.js";
import { createReferenceLicenseIssuer } from "./license/reference-issuer.js";
import { appendEntry, verifyChain } from "./receipts/chain.js";
import { ReceiptConflictError } from "./receipts/receipt-store.js";
import type { ReceiptStore } from "./receipts/receipt-store.js";
import {
  SecretKeyError,
  assertValidSecretKey,
  assertValidSecretPrefix,
  credentialSecretKey,
  leaseSecretPrefix,
} from "./ports/secret-store.js";
import type { SecretStore } from "./ports/secret-store.js";
import type { KeyProvider, RuntimeKey, RuntimePublicJwk } from "./ports/key-provider.js";
import type { LeaseArtifactName, LeaseArtifactStore } from "./ports/lease-artifact-store.js";
import type { Telemetry, TelemetryEvent } from "./ports/telemetry.js";
import { safeEmit } from "./ports/telemetry.js";
import { signCheckpoint, verifyCheckpoint } from "./receipts/checkpoint.js";

/**
 * An in-memory `LeaseStore` double backed by a `Map<string, Lease>`.
 * `transaction(id, mutate)` is implemented as a per-id promise chain: each
 * call for a given `id` appends its load-mutate-save work to that id's tail
 * promise, so same-id operations run strictly one after another while
 * different ids proceed independently (D-13). Rejects `transaction` when
 * `id` is absent — the caller must `save` an initial lease first.
 */
export function createInMemoryLeaseStore(): LeaseStore {
  const leases = new Map<string, Lease>();
  const tails = new Map<string, Promise<unknown>>();

  function runSerialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previousTail = tails.get(id) ?? Promise.resolve();
    // Swallow a prior failure so one rejected transaction never wedges the
    // chain for later, unrelated transactions on the same id.
    const next = previousTail.catch(() => undefined).then(work);
    tails.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  return {
    load(id: string): Promise<Lease | undefined> {
      return Promise.resolve(leases.get(id));
    },

    save(lease: Lease): Promise<void> {
      leases.set(lease.id, lease);
      return Promise.resolve();
    },

    list(): Promise<readonly Lease[]> {
      return Promise.resolve(Array.from(leases.values()));
    },

    scan(): Promise<readonly LeaseScanEntry[]> {
      const entries = Array.from(leases.values())
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((lease): LeaseScanEntry => ({ id: lease.id, lease }));
      return Promise.resolve(entries);
    },

    delete(id: string): Promise<void> {
      leases.delete(id);
      return Promise.resolve();
    },

    transaction(id: string, mutate: LeaseMutator): Promise<Lease> {
      return runSerialized(id, async () => {
        const current = leases.get(id);
        if (current === undefined) {
          throw new Error(`@stint/core/testing: transaction("${id}") called before any lease was saved for that id.`);
        }
        const next = await mutate(current);
        leases.set(id, next);
        return next;
      });
    },
  };
}

/**
 * A fixed/deterministic `active`-state `Lease` fixture (D-14). Exported (not
 * merely module-private) so downstream test suites — including this file's
 * own `makeTearingDownTestLease` and Phase 5's proxy teardown tests — can
 * build on the same baseline lease shape instead of hand-rolling one.
 */
export function makeTestLease(id: string, overrides?: Partial<Lease>): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: 1000,
    expiresAt: 999_999_999,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

/**
 * A `tearing_down`-state `Lease` fixture (D-14) for constructing
 * partially-torn-down leases in downstream tests (Phase 5's teardown
 * orchestrator/steps). Builds on `makeTestLease` and accepts the same
 * override shape, defaulting `teardownProgress` to `{}` (teardown started,
 * no step outcomes recorded yet) unless the caller supplies its own partial
 * progress record via `overrides`.
 */
export function makeTearingDownTestLease(id: string, overrides?: Partial<Lease>): Lease {
  return makeTestLease(id, { state: "tearing_down", teardownProgress: {}, ...overrides });
}

/**
 * Registers a reusable Vitest `describe` block that exercises ANY
 * `LeaseStore` implementation `makeStore()` supplies — CRUD edges plus the
 * no-lost-updates proof under concurrency (D-13, D-14). Both the in-memory
 * double above and the Phase 6 JSON-file store call this same factory, so
 * neither can drift from the other's guarantees.
 */
export function createLeaseStoreContractTests(makeStore: () => LeaseStore): void {
  describe("LeaseStore contract", () => {
    it("CRUD: load(missing) returns undefined; list() on a fresh store returns []", async () => {
      const store = makeStore();
      expect(await store.load("missing")).toBeUndefined();
      expect(await store.list()).toEqual([]);
    });

    it("CRUD: after save(lease), load(lease.id) returns an equal lease", async () => {
      const store = makeStore();
      const lease = makeTestLease("lease-1");
      await store.save(lease);
      expect(await store.load("lease-1")).toEqual(lease);
    });

    it("CRUD: after saving two leases, list() returns both", async () => {
      const store = makeStore();
      const leaseA = makeTestLease("lease-a");
      const leaseB = makeTestLease("lease-b");
      await store.save(leaseA);
      await store.save(leaseB);
      const all = await store.list();
      expect(all).toHaveLength(2);
      expect(all).toEqual(expect.arrayContaining([leaseA, leaseB]));
    });

    it("SCAN: scan() returns one readable entry per lease in ascending id order", async () => {
      const store = makeStore();
      expect(await store.scan()).toEqual([]);
      const leaseB = makeTestLease("lease-b");
      const leaseA = makeTestLease("lease-a");
      await store.save(leaseB);
      await store.save(leaseA);
      const scanned = await store.scan();
      expect(scanned.map((entry) => entry.id)).toEqual(["lease-a", "lease-b"]);
      expect(scanned).toEqual([
        { id: "lease-a", lease: leaseA },
        { id: "lease-b", lease: leaseB },
      ]);
    });

    it("CRUD: after delete(id), load(id) returns undefined", async () => {
      const store = makeStore();
      const lease = makeTestLease("lease-del");
      await store.save(lease);
      await store.delete("lease-del");
      expect(await store.load("lease-del")).toBeUndefined();
    });

    it("SERIALIZATION: 50 concurrent transaction() calls on one id produce no lost updates", async () => {
      const store = makeStore();
      const lease = makeTestLease("lease-concurrent", { version: 0 });
      await store.save(lease);

      const bump: LeaseMutator = (current) => ({ ...current, version: current.version + 1 });

      await Promise.all(Array.from({ length: 50 }, () => store.transaction("lease-concurrent", bump)));

      const finalLease = await store.load("lease-concurrent");
      expect(finalLease?.version).toBe(50);
    });

    it("INDEPENDENT IDS: concurrent transactions on two different ids both complete correctly", async () => {
      const store = makeStore();
      await store.save(makeTestLease("lease-x", { version: 0 }));
      await store.save(makeTestLease("lease-y", { version: 0 }));

      const bump: LeaseMutator = (current) => ({ ...current, version: current.version + 1 });

      await Promise.all([
        ...Array.from({ length: 10 }, () => store.transaction("lease-x", bump)),
        ...Array.from({ length: 10 }, () => store.transaction("lease-y", bump)),
      ]);

      expect((await store.load("lease-x"))?.version).toBe(10);
      expect((await store.load("lease-y"))?.version).toBe(10);
    });

    it("ABSENT ID: transaction('missing', ...) rejects", async () => {
      const store = makeStore();
      await expect(store.transaction("missing", (l) => l)).rejects.toThrow();
    });
  });
}

/**
 * An in-memory `ReceiptStore` double backed by one `Map<ReceiptChain,
 * ReceiptEntry[]>` (append order preserved per chain) plus one
 * `Map<ReceiptChain, Checkpoint>` for the latest checkpoint per chain
 * (D-08). The two chains (`"verified"` / `"attested"`) never bleed into
 * each other: each has its own array/slot. `append` pushes onto the
 * chain's array without ever removing or reordering a prior entry —
 * append-only by construction, not by convention.
 */
export function createInMemoryReceiptStore(): ReceiptStore {
  const chains = new Map<ReceiptChain, ReceiptEntry[]>();
  const checkpoints = new Map<ReceiptChain, Checkpoint>();

  function entriesFor(chain: ReceiptChain): ReceiptEntry[] {
    let entries = chains.get(chain);
    if (entries === undefined) {
      entries = [];
      chains.set(chain, entries);
    }
    return entries;
  }

  return {
    append(chain: ReceiptChain, entry: ReceiptEntry): Promise<void> {
      const entries = entriesFor(chain);
      if (entry.seq !== entries.length) {
        return Promise.reject(new ReceiptConflictError(chain, entries.length));
      }
      entries.push(entry);
      return Promise.resolve();
    },

    load(chain: ReceiptChain): Promise<readonly ReceiptEntry[]> {
      return Promise.resolve([...entriesFor(chain)]);
    },

    readCheckpoint(chain: ReceiptChain): Promise<Checkpoint | undefined> {
      return Promise.resolve(checkpoints.get(chain));
    },

    writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
      checkpoints.set(checkpoint.chain, checkpoint);
      return Promise.resolve();
    },
  };
}

/**
 * Registers a reusable Vitest `describe` block that exercises ANY
 * `ReceiptStore` implementation `makeStore()` supplies — append-only
 * integrity (D-08): append order preserved, a loaded chain still passes
 * `verifyChain`, the two chains never bleed into each other, and a written
 * checkpoint reads back unchanged. Both the in-memory double above and the
 * Phase 6 JSON-file store call this same factory, so neither can drift from
 * the other's guarantees.
 */
export function createReceiptStoreContractTests(makeStore: () => ReceiptStore): void {
  describe("ReceiptStore contract", () => {
    it("EMPTY: a fresh store's load returns [] and readCheckpoint returns undefined", async () => {
      const store = makeStore();
      expect(await store.load("verified")).toEqual([]);
      expect(await store.readCheckpoint("verified")).toBeUndefined();
    });

    it("APPEND ORDER: appended entries load back in the exact order they were appended", async () => {
      const store = makeStore();
      let chain: readonly ReceiptEntry[] = [];
      const entries = [];
      for (let i = 0; i < 3; i++) {
        const entry = appendEntry(
          chain,
          {
            chain: "verified",
            type: "transition",
            payload: { from: `state-${String(i)}`, event: "advance", actor: "runtime", to: `state-${String(i + 1)}` },
          },
          1000 + i,
        );
        chain = [...chain, entry];
        entries.push(entry);
        await store.append("verified", entry);
      }

      expect(await store.load("verified")).toEqual(entries);
    });

    it("INTEGRITY: a chain persisted then loaded back still passes verifyChain", async () => {
      const store = makeStore();
      let chain: readonly ReceiptEntry[] = [];
      for (let i = 0; i < 3; i++) {
        const entry = appendEntry(
          chain,
          {
            chain: "verified",
            type: "transition",
            payload: { from: `state-${String(i)}`, event: "advance", actor: "runtime", to: `state-${String(i + 1)}` },
          },
          1000 + i,
        );
        chain = [...chain, entry];
        await store.append("verified", entry);
      }

      const loaded = await store.load("verified");
      const result = await verifyChain(loaded);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.count).toBe(3);
      }
    });

    it("ISOLATION: the verified and attested chains never bleed into each other", async () => {
      const store = makeStore();
      const verifiedEntry = appendEntry(
        [],
        { chain: "verified", type: "transition", payload: { from: "created", event: "activate", actor: "runtime", to: "active" } },
        1000,
      );
      const attestedEntry = appendEntry(
        [],
        {
          chain: "attested",
          type: "attested_claim",
          payload: { publisherId: "pub-1", kid: "key-1", claimType: "usage", claimHash: "jcs-sha256:bb", sig: "sig" },
        },
        1000,
      );

      await store.append("verified", verifiedEntry);
      await store.append("attested", attestedEntry);

      expect(await store.load("verified")).toEqual([verifiedEntry]);
      expect(await store.load("attested")).toEqual([attestedEntry]);
    });

    it("SEQ GUARD: an entry whose seq is not the current length is rejected with ReceiptConflictError and nothing is written", async () => {
      const store = makeStore();
      const first = appendEntry(
        [],
        { chain: "verified", type: "transition", payload: { from: "created", event: "activate", actor: "runtime", to: "active" } },
        1000,
      );
      const second = appendEntry(
        [first],
        { chain: "verified", type: "transition", payload: { from: "active", event: "revoke", actor: "runtime", to: "revoked" } },
        1001,
      );
      const third = appendEntry(
        [first, second],
        { chain: "verified", type: "transition", payload: { from: "revoked", event: "settle", actor: "runtime", to: "settled" } },
        1002,
      );

      // Skipped seq: seq 1 onto an empty chain.
      await expect(store.append("verified", second)).rejects.toBeInstanceOf(ReceiptConflictError);
      expect(await store.load("verified")).toEqual([]);

      await store.append("verified", first);

      // Stale seq: seq 0 again onto a chain of length 1.
      const stale = await store.append("verified", first).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(stale).toBeInstanceOf(ReceiptConflictError);
      expect((stale as ReceiptConflictError).chain).toBe("verified");
      expect((stale as ReceiptConflictError).expectedSeq).toBe(1);

      // Skipped seq: seq 2 onto a chain of length 1.
      await expect(store.append("verified", third)).rejects.toBeInstanceOf(ReceiptConflictError);
      expect(await store.load("verified")).toEqual([first]);

      // Per-chain independence: seq 0 on "attested" succeeds while "verified" has entries.
      const attested = appendEntry(
        [],
        {
          chain: "attested",
          type: "attested_claim",
          payload: { publisherId: "pub-1", kid: "key-1", claimType: "usage", claimHash: "jcs-sha256:bb", sig: "sig" },
        },
        1000,
      );
      await store.append("attested", attested);
      expect(await store.load("attested")).toEqual([attested]);

      // The correct next seq still succeeds after the rejections.
      await store.append("verified", second);
      expect(await store.load("verified")).toEqual([first, second]);
    });

    it("CHECKPOINT: a written checkpoint reads back byte-equal", async () => {
      const store = makeStore();
      const checkpoint: Checkpoint = {
        chain: "verified",
        count: 1,
        headHash: "jcs-sha256:" + "1".repeat(64),
        ts: 2000,
        sig: "test-sig",
      };

      await store.writeCheckpoint(checkpoint);

      expect(await store.readCheckpoint("verified")).toEqual(checkpoint);
    });

    it("CHECKPOINT ISOLATION: checkpoints for different chains do not overwrite each other", async () => {
      const store = makeStore();
      const verifiedCheckpoint: Checkpoint = {
        chain: "verified",
        count: 1,
        headHash: "jcs-sha256:" + "1".repeat(64),
        ts: 2000,
        sig: "verified-sig",
      };
      const attestedCheckpoint: Checkpoint = {
        chain: "attested",
        count: 1,
        headHash: "jcs-sha256:" + "2".repeat(64),
        ts: 2000,
        sig: "attested-sig",
      };

      await store.writeCheckpoint(verifiedCheckpoint);
      await store.writeCheckpoint(attestedCheckpoint);

      expect(await store.readCheckpoint("verified")).toEqual(verifiedCheckpoint);
      expect(await store.readCheckpoint("attested")).toEqual(attestedCheckpoint);
    });
  });
}

/** The fixed `kid` the mock `LicenseIssuer` signs under (D-11). */
export const MOCK_LICENSE_ISSUER_KID = "mock-publisher-test-key";

/** A `LicenseIssuer` plus its public key, exposed so a test can independently `verifyLicense` what it issued. */
export interface MockLicenseIssuer extends LicenseIssuer {
  readonly publicKey: PublicKey;
}

/**
 * A `LicenseIssuer` (D-11) backed by a fresh Ed25519 keypair generated for
 * this call, composing the reference `issueLicense` (`packages/core/src/
 * license/issue.ts`) and wrapping its raw token in a `HeldLicense` via
 * `mintHeldLicense` -- the mock publisher never hands a bare token string to
 * a caller. `reissue` enforces the LIC-03 clamp itself via
 * `clampedLicenseExpiry`, refusing (returning `null`) once the clamp is
 * `null`. Mirrors this file's existing "test double with fixed/deterministic
 * fixture data" convention (e.g. `makeTestLease` above). Phase 7's mock
 * publisher reuses this shape.
 */
export async function createMockLicenseIssuer(): Promise<MockLicenseIssuer> {
  // Delegates to the vitest-free reference issuer (`@stint/core/license-issuer`)
  // so the test double and the runtime-importable issuer can never drift.
  const { issuer, publicKey } = await createReferenceLicenseIssuer({ kid: MOCK_LICENSE_ISSUER_KID });
  return { ...issuer, publicKey };
}

/** Runs `work` and surfaces a synchronous throw as a rejected promise, as an async port method would. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * An in-memory `SecretStore` double backed by one `Map<string, string>`.
 * Every method validates its key or prefix with the exported grammar helpers,
 * and `deletePrefix` matches on the validated prefix including its trailing
 * slash, so `lease/a/` never reaches `lease/ab/`.
 */
export function createInMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();

  return {
    get(key: string): Promise<string | undefined> {
      return settle(() => {
        assertValidSecretKey(key);
        return secrets.get(key);
      });
    },

    put(key: string, value: string): Promise<void> {
      return settle(() => {
        assertValidSecretKey(key);
        secrets.set(key, value);
      });
    },

    delete(key: string): Promise<void> {
      return settle(() => {
        assertValidSecretKey(key);
        secrets.delete(key);
      });
    },

    deletePrefix(prefix: string): Promise<number> {
      return settle(() => {
        assertValidSecretPrefix(prefix);
        let removed = 0;
        for (const key of Array.from(secrets.keys())) {
          if (key.startsWith(prefix)) {
            secrets.delete(key);
            removed += 1;
          }
        }
        return removed;
      });
    },
  };
}

/**
 * Registers a reusable Vitest `describe` block that exercises ANY `SecretStore`
 * implementation `makeStore()` supplies: round trips, last-write-wins, the
 * prefix segment boundary, key grammar rejection and concurrent puts (RT-02).
 * Lease ids match the CLI lease id pattern so a file-backed store can run the
 * same suite unchanged.
 */
export function createSecretStoreContractTests(makeStore: () => SecretStore): void {
  describe("SecretStore contract", () => {
    it("EMPTY: get on a missing key resolves undefined", async () => {
      const store = makeStore();
      expect(await store.get(credentialSecretKey("lease-1", "sheets"))).toBeUndefined();
    });

    it("ROUND TRIP: a value with unicode, a newline and 10,000 characters reads back unchanged", async () => {
      const store = makeStore();
      const key = credentialSecretKey("lease-1", "sheets");
      const value = `héllo 世界 😀\nline2 ${"x".repeat(10_000)}`;
      await store.put(key, value);
      expect(await store.get(key)).toBe(value);
    });

    it("REPLACE: put on an existing key replaces the value", async () => {
      const store = makeStore();
      const key = credentialSecretKey("lease-1", "sheets");
      await store.put(key, "first");
      await store.put(key, "second");
      expect(await store.get(key)).toBe("second");
    });

    it("DELETE: delete removes the key and delete of a missing key does not throw", async () => {
      const store = makeStore();
      const key = credentialSecretKey("lease-1", "sheets");
      await store.put(key, "v");
      await store.delete(key);
      expect(await store.get(key)).toBeUndefined();
      await expect(store.delete(key)).resolves.toBeUndefined();
    });

    it("DELETE PREFIX: removes every key under the prefix and returns the count", async () => {
      const store = makeStore();
      await store.put(credentialSecretKey("lease-1", "a"), "1");
      await store.put(credentialSecretKey("lease-1", "b"), "2");
      await store.put(credentialSecretKey("lease-1", "c"), "3");
      expect(await store.deletePrefix(leaseSecretPrefix("lease-1"))).toBe(3);
      expect(await store.get(credentialSecretKey("lease-1", "a"))).toBeUndefined();
      expect(await store.get(credentialSecretKey("lease-1", "b"))).toBeUndefined();
      expect(await store.get(credentialSecretKey("lease-1", "c"))).toBeUndefined();
    });

    it("PREFIX BOUNDARY: deletePrefix on lease/a/ leaves every key under lease/ab/ in place", async () => {
      const store = makeStore();
      await store.put(credentialSecretKey("a", "x"), "mine");
      await store.put(credentialSecretKey("ab", "x"), "neighbour");
      expect(await store.deletePrefix(leaseSecretPrefix("a"))).toBe(1);
      expect(await store.get(credentialSecretKey("a", "x"))).toBeUndefined();
      expect(await store.get(credentialSecretKey("ab", "x"))).toBe("neighbour");
    });

    it("EMPTY PREFIX MATCH: deletePrefix that matches nothing resolves 0", async () => {
      const store = makeStore();
      expect(await store.deletePrefix(leaseSecretPrefix("nobody"))).toBe(0);
    });

    it("ISOLATION: keys under different leases do not see each other", async () => {
      const store = makeStore();
      await store.put(credentialSecretKey("lease-1", "sheets"), "one");
      await store.put(credentialSecretKey("lease-2", "sheets"), "two");
      expect(await store.get(credentialSecretKey("lease-1", "sheets"))).toBe("one");
      expect(await store.get(credentialSecretKey("lease-2", "sheets"))).toBe("two");
    });

    it("INVALID KEYS: reject with SecretKeyError and never echo the key", async () => {
      const store = makeStore();
      const invalid = ["", "lease//x", "lease/../x", "lease/./x", "lease/a\\b", "lease/a\u0000b", "lease/a\nb"];
      for (const key of invalid) {
        await expect(store.get(key)).rejects.toBeInstanceOf(SecretKeyError);
        await expect(store.put(key, "v")).rejects.toBeInstanceOf(SecretKeyError);
        await expect(store.delete(key)).rejects.toBeInstanceOf(SecretKeyError);
      }
      const error = await store.put("lease/../secret-marker", "v").catch((e: unknown) => e as Error);
      expect((error as Error).message).not.toContain("secret-marker");
    });

    it("INVALID PREFIXES: deletePrefix rejects a prefix with no trailing slash and the empty prefix", async () => {
      const store = makeStore();
      await expect(store.deletePrefix("lease/a")).rejects.toBeInstanceOf(SecretKeyError);
      await expect(store.deletePrefix("")).rejects.toBeInstanceOf(SecretKeyError);
      await expect(store.deletePrefix("/")).rejects.toBeInstanceOf(SecretKeyError);
    });

    it("HOSTILE NAMES: reserved-looking, spaced, long and non-ASCII final segments round trip", async () => {
      const store = makeStore();
      const names = ["con", "NUL", "aux.txt", "a b", "n".repeat(128), "über-çréd"];
      for (const name of names) {
        const key = credentialSecretKey("lease-1", name);
        await store.put(key, `value:${name}`);
        expect(await store.get(key)).toBe(`value:${name}`);
      }
    });

    it("CONCURRENCY: 20 concurrent puts to one key leave exactly one of the written values", async () => {
      const store = makeStore();
      const key = credentialSecretKey("lease-1", "sheets");
      const values = Array.from({ length: 20 }, (_, i) => `value-${String(i)}-${"z".repeat(2000)}`);
      await Promise.all(values.map((value) => store.put(key, value)));
      const final = await store.get(key);
      expect(final).toBeDefined();
      expect(values).toContain(final);
    });

    it("ORDERING: a later put wins over an earlier completed put", async () => {
      const store = makeStore();
      const key = credentialSecretKey("lease-1", "sheets");
      await store.put(key, "earlier");
      await store.put(key, "later");
      expect(await store.get(key)).toBe("later");
    });
  });
}

/**
 * An in-memory `KeyProvider` double. The Ed25519 pair is generated on first
 * `loadOrCreate`; the in-flight promise is memoised so concurrent callers share
 * one key. `loadVerificationKeys` is empty until a key exists.
 */
export function createInMemoryKeyProvider(): KeyProvider {
  let pending: Promise<RuntimeKey> | undefined;

  function create(): Promise<RuntimeKey> {
    pending ??= (async (): Promise<RuntimeKey> => {
      const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
      const jwk = await exportJWK(pair.publicKey);
      const publicJwk: RuntimePublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x as string };
      return {
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
        publicJwk,
        kid: await calculateJwkThumbprint(publicJwk),
      };
    })();
    return pending;
  }

  return {
    loadOrCreate(): Promise<RuntimeKey> {
      return create();
    },

    async loadVerificationKeys() {
      if (pending === undefined) return [];
      const key = await pending;
      return [{ kid: key.kid, publicKey: key.publicKey, publicJwk: key.publicJwk }];
    },
  };
}

/**
 * Registers a reusable Vitest `describe` block that exercises ANY `KeyProvider`
 * implementation `makeProvider()` supplies: empty before creation, a stable
 * `kid`, a public-only verification key, a real signed checkpoint that
 * verifies through it, and concurrent creation (RT-02).
 */
export function createKeyProviderContractTests(makeProvider: () => KeyProvider): void {
  describe("KeyProvider contract", () => {
    it("EMPTY: loadVerificationKeys on a fresh provider resolves an empty array", async () => {
      const provider = makeProvider();
      expect(await provider.loadVerificationKeys()).toEqual([]);
    });

    it("STABLE KID: loadOrCreate returns a non-empty kid and a second call returns the same kid", async () => {
      const provider = makeProvider();
      const first = await provider.loadOrCreate();
      const second = await provider.loadOrCreate();
      expect(first.kid.length).toBeGreaterThan(0);
      expect(second.kid).toBe(first.kid);
    });

    it("VERIFICATION KEYS: after loadOrCreate the list holds that kid and its public JWK has no d member", async () => {
      const provider = makeProvider();
      const key = await provider.loadOrCreate();
      const keys = await provider.loadVerificationKeys();
      const match = keys.find((candidate) => candidate.kid === key.kid);
      expect(match).toBeDefined();
      expect(Object.keys(match?.publicJwk ?? {})).not.toContain("d");
    });

    it("SIGN AND VERIFY: a checkpoint signed with the private key verifies with the verification key", async () => {
      const provider = makeProvider();
      const key = await provider.loadOrCreate();
      const checkpoint = await signCheckpoint("verified", 1, `jcs-sha256:${"1".repeat(64)}`, 2000, key.privateKey);
      const verification = (await provider.loadVerificationKeys()).find((candidate) => candidate.kid === key.kid);
      expect(verification).toBeDefined();
      if (verification === undefined) return;
      expect(await verifyCheckpoint(checkpoint, verification.publicKey)).toBe(true);
      expect(await verifyCheckpoint({ ...checkpoint, count: 2 }, verification.publicKey)).toBe(false);
    });

    it("CONCURRENCY: 5 concurrent loadOrCreate calls resolve the same kid", async () => {
      const provider = makeProvider();
      const keys = await Promise.all(Array.from({ length: 5 }, () => provider.loadOrCreate()));
      expect(new Set(keys.map((key) => key.kid)).size).toBe(1);
    });
  });
}

/**
 * An in-memory `LeaseArtifactStore` double: a Map keyed by lease id and
 * artifact name that stores and returns a `structuredClone`, so a caller can
 * never mutate a stored artifact through a retained reference.
 */
export function createInMemoryLeaseArtifactStore(): LeaseArtifactStore {
  const artifacts = new Map<string, unknown>();
  const slot = (leaseId: string, name: LeaseArtifactName): string => JSON.stringify([leaseId, name]);

  return {
    get(leaseId: string, name: LeaseArtifactName): Promise<unknown> {
      const value = artifacts.get(slot(leaseId, name));
      return Promise.resolve(value === undefined ? undefined : structuredClone(value));
    },

    put(leaseId: string, name: LeaseArtifactName, value: unknown): Promise<void> {
      artifacts.set(slot(leaseId, name), structuredClone(value));
      return Promise.resolve();
    },
  };
}

/**
 * Registers a reusable Vitest `describe` block that exercises ANY
 * `LeaseArtifactStore` implementation `makeStore()` supplies: absence, deep
 * round trips for every name, isolation between names and leases, and
 * replacement (RT-02).
 */
export function createLeaseArtifactStoreContractTests(makeStore: () => LeaseArtifactStore): void {
  describe("LeaseArtifactStore contract", () => {
    const names: readonly LeaseArtifactName[] = ["envelope", "publisher", "grants", "run_heartbeat"];

    it("ABSENT: get of an absent artifact resolves undefined", async () => {
      const store = makeStore();
      for (const name of names) {
        expect(await store.get("lease-1", name)).toBeUndefined();
      }
    });

    it("ROUND TRIP: put then get deep-equals for each name, including nested objects and arrays", async () => {
      const store = makeStore();
      const value = { version: 1, nested: { list: [1, "two", { three: 3 }], flag: true }, items: [] as unknown[] };
      for (const name of names) {
        await store.put("lease-1", name, value);
        expect(await store.get("lease-1", name)).toEqual(value);
      }
    });

    it("ISOLATION: names are isolated from each other and leases are isolated from each other", async () => {
      const store = makeStore();
      await store.put("lease-1", "envelope", { who: "envelope-1" });
      await store.put("lease-1", "grants", { who: "grants-1" });
      await store.put("lease-2", "envelope", { who: "envelope-2" });
      expect(await store.get("lease-1", "envelope")).toEqual({ who: "envelope-1" });
      expect(await store.get("lease-1", "grants")).toEqual({ who: "grants-1" });
      expect(await store.get("lease-1", "publisher")).toBeUndefined();
      expect(await store.get("lease-2", "envelope")).toEqual({ who: "envelope-2" });
      expect(await store.get("lease-2", "grants")).toBeUndefined();
    });

    it("REPLACE: put replaces the previous value", async () => {
      const store = makeStore();
      await store.put("lease-1", "publisher", { v: 1 });
      await store.put("lease-1", "publisher", { v: 2 });
      expect(await store.get("lease-1", "publisher")).toEqual({ v: 2 });
    });
  });
}

/** A `Telemetry` double that records every event in emission order. */
export function createRecordingTelemetry(): Telemetry & { readonly events: readonly TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return {
    events,
    emit(event: TelemetryEvent): void {
      events.push(event);
    },
  };
}

/**
 * Registers a reusable Vitest `describe` block that exercises ANY `Telemetry`
 * implementation `makeTelemetry()` supplies: every event shape is accepted
 * without throwing, and `safeEmit` never lets a faulty sink escape (D-25).
 */
export function createTelemetryContractTests(makeTelemetry: () => Telemetry): void {
  describe("Telemetry contract", () => {
    const events: readonly TelemetryEvent[] = [
      { name: "call.decided", leaseId: "lease-1", tool: "sheets.read", outcome: "allowed" },
      { name: "call.decided", leaseId: "lease-1", tool: "sheets.write", outcome: "denied", reason: "over_budget" },
      { name: "lease.transition", leaseId: "lease-1", from: "granted", to: "active", actor: "runtime" },
      { name: "teardown.step", leaseId: "lease-1", step: "revoke_oauth", outcome: "revoked" },
      { name: "teardown.blocked", leaseId: "lease-1", reason: "credentials_unavailable", resourceCount: 2 },
      { name: "teardown.fence_takeover", leaseId: "lease-1", previousEpoch: 1, epoch: 2 },
      { name: "supervisor.action", leaseId: "lease-1", action: "expired" },
      { name: "supervisor.action", leaseId: "lease-1", action: "torn_down" },
    ];

    it("EMIT: accepts each event shape without throwing", () => {
      const telemetry = makeTelemetry();
      for (const event of events) {
        expect(() => {
          telemetry.emit(event);
        }).not.toThrow();
      }
    });

    it("SAFE EMIT: a sink whose emit throws does not make safeEmit throw", () => {
      const throwing: Telemetry = {
        emit(): void {
          throw new Error("sink exploded");
        },
      };
      for (const event of events) {
        expect(() => {
          safeEmit(throwing, event);
        }).not.toThrow();
      }
    });

    it("SAFE EMIT: undefined sink is a no-op", () => {
      for (const event of events) {
        expect(() => {
          safeEmit(undefined, event);
        }).not.toThrow();
      }
    });

    it("SAFE EMIT: delivers to a working sink", () => {
      const telemetry = makeTelemetry();
      for (const event of events) {
        expect(() => {
          safeEmit(telemetry, event);
        }).not.toThrow();
      }
    });
  });
}
