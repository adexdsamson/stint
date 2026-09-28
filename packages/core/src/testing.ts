/**
 * `@stint/core/testing` — the in-memory `LeaseStore` double and the reusable
 * `createLeaseStoreContractTests` suite factory (D-14). This subpath is the
 * ONLY place a `LeaseStore` implementation is exercised generically: the
 * public `.` entry (`./index.ts`) never re-exports anything from this file,
 * so production code cannot accidentally depend on the test double.
 *
 * Phase 6's JSON-file `LeaseStore` (HOST-03, backed by `proper-lockfile` for
 * cross-process safety) imports `createLeaseStoreContractTests` and runs the
 * IDENTICAL suite against its own implementation, so the two stores cannot
 * silently drift from the per-lease serialization guarantee ALP.md Section 9
 * requires (D-13).
 */

import { describe, expect, it } from "vitest";

import { PublicProtocol } from "paseto";
import { GenerateKeyPairFactory } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";

import type { Lease } from "./lease.js";
import type { LeaseMutator, LeaseStore } from "./lease-store.js";
import { issueLicense } from "./license/issue.js";
import type { LicenseClaims } from "./license/issue.js";
import { mintHeldLicense } from "./license/held-license.js";
import type { HeldLicense } from "./license/held-license.js";
import { clampedLicenseExpiry, DEFAULT_LICENSE_TTL_SECONDS } from "./license/refresh.js";
import type { LicenseIssuer } from "./license/license-issuer.js";

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

function makeTestLease(id: string, overrides?: Partial<Lease>): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: 1000,
    expiresAt: 999_999_999,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [] },
    ...overrides,
  };
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

/** The fixed `kid` the mock `LicenseIssuer` signs under (D-11). */
export const MOCK_LICENSE_ISSUER_KID = "mock-publisher-test-key";

const keyPairProtocol = new PublicProtocol(GenerateKeyPairFactory);

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
  const { secretKey, publicKey } = await keyPairProtocol.GenerateKeyPair({ extractable: true });
  const kid = MOCK_LICENSE_ISSUER_KID;

  async function issue(
    claims: LicenseClaims,
    specVersion: string,
    now: number,
    expEpochSeconds: number,
    jti?: string,
  ): Promise<HeldLicense> {
    const token = await issueLicense(secretKey, claims, kid, specVersion, now, expEpochSeconds, jti);
    return mintHeldLicense(token);
  }

  async function reissue(
    claims: LicenseClaims,
    specVersion: string,
    now: number,
    leaseExpiresAt: number,
    jti?: string,
  ): Promise<HeldLicense | null> {
    const expEpochSeconds = clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt);
    if (expEpochSeconds === null) return null;
    return issue(claims, specVersion, now, expEpochSeconds, jti);
  }

  return { kid, publicKey, issue, reissue };
}
