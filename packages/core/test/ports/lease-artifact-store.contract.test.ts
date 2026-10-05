import { describe, expect, it } from "vitest";

import type { LeaseArtifactName, LeaseArtifactStore } from "../../src/ports/lease-artifact-store.js";
import { parseGrantsArtifact } from "../../src/ports/lease-artifact-store.js";
import { createInMemoryLeaseArtifactStore, createLeaseArtifactStoreContractTests } from "../../src/testing.js";

/**
 * A second implementation written only from the `LeaseArtifactStore` type: a
 * nested Map round-tripped through JSON. Passing the shared suite proves a
 * platform builder can implement the port from the published types alone.
 */
function makeIndependentArtifactStore(): LeaseArtifactStore {
  const byLease = new Map<string, Map<LeaseArtifactName, string>>();
  return {
    get(leaseId, name) {
      const text = byLease.get(leaseId)?.get(name);
      return Promise.resolve(text === undefined ? undefined : (JSON.parse(text) as unknown));
    },
    put(leaseId, name, value) {
      const slots = byLease.get(leaseId) ?? new Map<LeaseArtifactName, string>();
      slots.set(name, JSON.stringify(value));
      byLease.set(leaseId, slots);
      return Promise.resolve();
    },
  };
}

createLeaseArtifactStoreContractTests(() => createInMemoryLeaseArtifactStore());
createLeaseArtifactStoreContractTests(() => makeIndependentArtifactStore());

describe("parseGrantsArtifact", () => {
  it("accepts a valid artifact with and without revocation", () => {
    const raw = {
      version: 1,
      grants: [
        { resource: "sheets.orders", kind: "oauth" },
        { resource: "stripe", kind: "api_key", revocation: "unsupported" },
        { resource: "gmail", kind: "oauth", revocation: "supported" },
      ],
    };
    expect(parseGrantsArtifact(raw)).toEqual(raw);
  });

  it("accepts an empty grants list", () => {
    expect(parseGrantsArtifact({ version: 1, grants: [] })).toEqual({ version: 1, grants: [] });
  });

  it("returns undefined for a wrong version", () => {
    expect(parseGrantsArtifact({ version: 2, grants: [] })).toBeUndefined();
  });

  it("returns undefined for non-array grants", () => {
    expect(parseGrantsArtifact({ version: 1, grants: "nope" })).toBeUndefined();
    expect(parseGrantsArtifact({ version: 1, grants: { resource: "x", kind: "oauth" } })).toBeUndefined();
  });

  it("returns undefined for an unknown kind, an unknown revocation or an empty resource", () => {
    expect(parseGrantsArtifact({ version: 1, grants: [{ resource: "x", kind: "password" }] })).toBeUndefined();
    expect(parseGrantsArtifact({ version: 1, grants: [{ resource: "x", kind: "oauth", revocation: "maybe" }] })).toBeUndefined();
    expect(parseGrantsArtifact({ version: 1, grants: [{ resource: "", kind: "oauth" }] })).toBeUndefined();
  });

  it("returns undefined for a non-object", () => {
    for (const raw of [undefined, null, "grants", 1, [], [{ version: 1, grants: [] }]]) {
      expect(parseGrantsArtifact(raw)).toBeUndefined();
    }
  });

  it("returns undefined when any single grant is invalid", () => {
    expect(
      parseGrantsArtifact({ version: 1, grants: [{ resource: "ok", kind: "oauth" }, null] }),
    ).toBeUndefined();
  });
});
