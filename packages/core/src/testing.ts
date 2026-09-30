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

import { describe, expect, it } from "vitest";

import type { PublicKey } from "paseto/v4/public";

import type { Checkpoint, ReceiptChain, ReceiptEntry } from "@stint/spec";

import type { Lease } from "./lease.js";
import type { LeaseMutator, LeaseStore } from "./lease-store.js";
import type { LicenseIssuer } from "./license/license-issuer.js";
import { createReferenceLicenseIssuer } from "./license/reference-issuer.js";
import { appendEntry, verifyChain } from "./receipts/chain.js";
import type { ReceiptStore } from "./receipts/receipt-store.js";

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
      entriesFor(chain).push(entry);
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
