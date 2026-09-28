import { describe, expect, it } from "vitest";

import { hashManifest, verifyEnvelope } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";
import type { Manifest, VerifiedManifest } from "@stint/spec";

import { activateLease, resumeLease } from "../src/activate.js";
import type { Lease } from "../src/lease.js";

/** A minimal manifest satisfying the generated schema, distinct per call via `agent.id`. */
function manifest(agentId: string): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: {
      id: agentId,
      name: "Test Agent",
      description: "A manifest used only to exercise activateLease/resumeLease.",
    },
    publisher: {
      id: "activate-tests.example",
      name: "Activate Tests",
    },
    version: "0.1.0",
    job: {
      description: "No-op job for activate/resume tests.",
      verifier: { type: "none" },
    },
    scopes: [{ resource: "sheets.orders", access: ["read"] }],
    lease: { max_duration_seconds: 3600 },
    limits: { max_actions: 10 },
    approvals: { require_for: [], timeout_seconds: 60 },
    auth: { mode: "hosted", hosted: { license_issuer: "activate-tests.example", kid: "test-key" } },
    cleanup: { hook: { url: "https://activate-tests.example/alp/cleanup" }, publisher_retains: "none" },
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

/** Builds a lease in an arbitrary state with sensible defaults, overridable per test. */
function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "lease-1",
    state: "granted",
    version: 3,
    boundHash: `jcs-sha256:${"0".repeat(64)}`,
    grantedAt: 1000,
    expiresAt: 5000,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

describe("activateLease", () => {
  it("ACTIVATE MATCH: a granted lease whose boundHash matches -> active, actor runtime, event activate", async () => {
    const vm = await verifiedManifestFor("agent-match");
    const boundHash = hashManifest(vm.manifest);
    const lease = makeLease({ state: "granted", boundHash });

    const result = activateLease(lease, vm, 2000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("active");
    expect(result.value.transition.actor).toBe("runtime");
    expect(result.value.transition.event).toBe("activate");
  });

  it("ACTIVATE MISMATCH: a granted lease bound to a DIFFERENT manifest -> failed, event activation_failed, actor runtime", async () => {
    const vm = await verifiedManifestFor("agent-presented");
    const otherVm = await verifiedManifestFor("agent-consented-to");
    const boundHash = hashManifest(otherVm.manifest);
    const lease = makeLease({ state: "granted", boundHash });

    const result = activateLease(lease, vm, 2000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("failed");
    expect(result.value.transition.event).toBe("activation_failed");
    expect(result.value.transition.actor).toBe("runtime");
  });
});

describe("resumeLease", () => {
  it("RESUME MISMATCH: an active lease with a mismatching bound hash -> failed, event runtime_failure, actor runtime", async () => {
    const vm = await verifiedManifestFor("agent-running");
    const otherVm = await verifiedManifestFor("agent-consented-to-2");
    const boundHash = hashManifest(otherVm.manifest);
    const lease = makeLease({ state: "active", boundHash });

    const result = resumeLease(lease, vm, 2000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("failed");
    expect(result.value.transition?.event).toBe("runtime_failure");
    expect(result.value.transition?.actor).toBe("runtime");
  });

  it("RESUME MATCH: an active lease with a matching bound hash stays active and emits no runtime_failure", async () => {
    const vm = await verifiedManifestFor("agent-resume-match");
    const boundHash = hashManifest(vm.manifest);
    const lease = makeLease({ state: "active", boundHash });

    const result = resumeLease(lease, vm, 2000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("active");
    expect(result.value.transition?.event).not.toBe("runtime_failure");
  });
});
