import { describe, expect, it } from "vitest";

import { verifyEnvelope } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";
import type { Manifest, VerifiedManifest } from "@stint/spec";

import { awaitApprovalDecision, awaitConsentDecision } from "../src/host-adapter.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ConsentDecision,
  ConsentRequest,
  HostAdapter,
} from "../src/host-adapter.js";
import type { ConnectorBinding } from "../src/bindings.js";

/** A minimal manifest satisfying the generated schema, used only to build a ConsentRequest. */
function manifest(agentId: string): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: {
      id: agentId,
      name: "Test Agent",
      description: "A manifest used only to exercise the HostAdapter timeout wrappers.",
    },
    publisher: {
      id: "host-adapter-tests.example",
      name: "HostAdapter Tests",
    },
    version: "0.1.0",
    job: {
      description: "No-op job for host-adapter tests.",
      verifier: { type: "none" },
    },
    scopes: [{ resource: "sheets.orders", access: ["read"] }],
    lease: { max_duration_seconds: 3600 },
    limits: { max_actions: 10 },
    approvals: { require_for: [], timeout_seconds: 60 },
    auth: { mode: "hosted", hosted: { license_issuer: "host-adapter-tests.example", kid: "test-key" } },
    cleanup: { hook: { url: "https://host-adapter-tests.example/alp/cleanup" }, publisher_retains: "none" },
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

const binding: ConnectorBinding = {
  tool: "sheets.append_row",
  resource: "sheets.orders",
  access: "write",
  irreversible: false,
  provenance: "built_in",
};

function approvalRequest(): ApprovalRequest {
  return { approvalId: "approval-1", summary: "Append a row to sheets.orders", binding };
}

async function consentRequest(): Promise<ConsentRequest> {
  return { consentId: "consent-1", manifest: await verifiedManifestFor("agent-consent") };
}

/** A fake HostAdapter whose only exercised methods are stubbed per test; the rest throw if called. */
function fakeAdapter(overrides: Partial<HostAdapter>): HostAdapter {
  return {
    requestConsent: overrides.requestConsent ?? (() => Promise.reject(new Error("not stubbed"))),
    requestApproval: overrides.requestApproval ?? (() => Promise.reject(new Error("not stubbed"))),
    notify: overrides.notify ?? (() => Promise.reject(new Error("not stubbed"))),
  };
}

describe("awaitApprovalDecision", () => {
  it("APPROVE PASSTHROUGH: a non-aborted approve resolves unchanged", async () => {
    const adapter = fakeAdapter({
      requestApproval: () => Promise.resolve({ decision: "approve" } satisfies ApprovalDecision),
    });
    const controller = new AbortController();

    const decision = await awaitApprovalDecision(adapter, approvalRequest(), controller.signal);

    expect(decision).toEqual({ decision: "approve" });
  });

  it("DENY PASSTHROUGH: an explicit user_denied resolves unchanged", async () => {
    const adapter = fakeAdapter({
      requestApproval: () =>
        Promise.resolve({ decision: "deny", reason: "user_denied" } satisfies ApprovalDecision),
    });
    const controller = new AbortController();

    const decision = await awaitApprovalDecision(adapter, approvalRequest(), controller.signal);

    expect(decision).toEqual({ decision: "deny", reason: "user_denied" });
  });

  it("APPROVAL TIMEOUT: a never-resolving adapter + abort resolves deny/timeout", async () => {
    const adapter = fakeAdapter({
      requestApproval: () => new Promise<ApprovalDecision>(() => {}),
    });
    const controller = new AbortController();

    const pending = awaitApprovalDecision(adapter, approvalRequest(), controller.signal);
    controller.abort();
    const decision = await pending;

    expect(decision).toEqual({ decision: "deny", reason: "timeout" });
  });

  it("APPROVAL ADAPTER ERROR: a rejecting adapter resolves deny/timeout, never an approve", async () => {
    const adapter = fakeAdapter({
      requestApproval: () => Promise.reject(new Error("adapter blew up")),
    });
    const controller = new AbortController();

    const decision = await awaitApprovalDecision(adapter, approvalRequest(), controller.signal);

    expect(decision).toEqual({ decision: "deny", reason: "timeout" });
  });

  it("ALREADY ABORTED: an already-aborted signal denies without awaiting a real timer", async () => {
    const adapter = fakeAdapter({
      requestApproval: () => new Promise<ApprovalDecision>(() => {}),
    });
    const controller = new AbortController();
    controller.abort();

    const decision = await awaitApprovalDecision(adapter, approvalRequest(), controller.signal);

    expect(decision).toEqual({ decision: "deny", reason: "timeout" });
  });
});

describe("awaitConsentDecision", () => {
  it("CONSENT GRANT PASSTHROUGH: a non-aborted grant resolves unchanged", async () => {
    const adapter = fakeAdapter({
      requestConsent: () => Promise.resolve({ decision: "grant" } satisfies ConsentDecision),
    });
    const controller = new AbortController();

    const decision = await awaitConsentDecision(adapter, await consentRequest(), controller.signal);

    expect(decision).toEqual({ decision: "grant" });
  });

  it("CONSENT TIMEOUT: a never-resolving adapter + abort resolves decline/timeout", async () => {
    const adapter = fakeAdapter({
      requestConsent: () => new Promise<ConsentDecision>(() => {}),
    });
    const controller = new AbortController();

    const pending = awaitConsentDecision(adapter, await consentRequest(), controller.signal);
    controller.abort();
    const decision = await pending;

    expect(decision).toEqual({ decision: "decline", reason: "timeout" });
  });

  it("CONSENT ADAPTER ERROR: a rejecting adapter resolves decline/timeout, never a grant", async () => {
    const adapter = fakeAdapter({
      requestConsent: () => Promise.reject(new Error("adapter blew up")),
    });
    const controller = new AbortController();

    const decision = await awaitConsentDecision(adapter, await consentRequest(), controller.signal);

    expect(decision).toEqual({ decision: "decline", reason: "timeout" });
  });
});
