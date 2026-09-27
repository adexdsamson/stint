import { describe, expect, it } from "vitest";

import { hashManifest, verifyEnvelope } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";
import type { Manifest, VerifiedManifest } from "@stint/spec";

import { verifyBoundHash } from "../src/hash-guard.js";

/** A minimal manifest satisfying the generated schema, distinct per call via `agent.id`. */
function manifest(agentId: string): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: {
      id: agentId,
      name: "Test Agent",
      description: "A manifest used only to exercise verifyBoundHash.",
    },
    publisher: {
      id: "hash-guard-tests.example",
      name: "Hash Guard Tests",
    },
    version: "0.1.0",
    job: {
      description: "No-op job for hash-guard tests.",
      verifier: { type: "none" },
    },
    scopes: [{ resource: "sheets.orders", access: ["read"] }],
    lease: { max_duration_seconds: 3600 },
    limits: { max_actions: 10 },
    approvals: { require_for: [], timeout_seconds: 60 },
    auth: { mode: "hosted", hosted: { license_issuer: "hash-guard-tests.example", kid: "test-key" } },
    cleanup: { hook: { url: "https://hash-guard-tests.example/alp/cleanup" }, publisher_retains: "none" },
  };
}

async function verifiedManifestFor(agentId: string): Promise<VerifiedManifest> {
  const m = manifest(agentId);
  const { envelope, trustStore } = await signManifestForTest(m);
  const result = await verifyEnvelope(envelope, trustStore);
  if (!result.ok) {
    throw new Error(`test setup failed to produce a VerifiedManifest: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

describe("verifyBoundHash", () => {
  it("MATCH: returns true when boundHash is hashManifest(vm.manifest)", async () => {
    const vm = await verifiedManifestFor("agent-a");
    const boundHash = hashManifest(vm.manifest);

    expect(verifyBoundHash(boundHash, vm)).toBe(true);
  });

  it("MISMATCH: returns false when boundHash belongs to a DIFFERENT manifest", async () => {
    const vm = await verifiedManifestFor("agent-b");
    const otherVm = await verifiedManifestFor("agent-c");
    const boundHash = hashManifest(otherVm.manifest);

    expect(verifyBoundHash(boundHash, vm)).toBe(false);
  });

  it("NO TRUST OF SUPPLIED FIELD: a tampered .contentHash matching boundHash does not make a mismatched .manifest pass", async () => {
    const vm = await verifiedManifestFor("agent-d");
    const otherVm = await verifiedManifestFor("agent-e");
    const boundHash = hashManifest(otherVm.manifest);

    // Tamper .contentHash to equal boundHash while leaving .manifest untouched —
    // verifyBoundHash must recompute from .manifest, not trust .contentHash.
    const tampered: VerifiedManifest = { ...vm, contentHash: boundHash };

    expect(verifyBoundHash(boundHash, tampered)).toBe(false);
  });
});
