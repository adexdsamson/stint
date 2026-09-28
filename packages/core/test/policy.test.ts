import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "../src/policy.js";
import type { PolicyCall } from "../src/policy.js";
import type { Lease } from "../src/lease.js";
import type { ConnectorBinding } from "../src/bindings.js";
import type { Approvals, Limits } from "@stint/spec";

function activeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "lease-1",
    state: "active",
    version: 3,
    boundHash: "jcs-sha256:0000000000000000000000000000000000000000000000000000000000000000",
    grantedAt: 0,
    expiresAt: 1000,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

function readBinding(overrides: Partial<ConnectorBinding> = {}): ConnectorBinding {
  return {
    tool: "sheets.read",
    resource: "sheets",
    access: "read",
    irreversible: false,
    provenance: "built_in",
    ...overrides,
  };
}

function baseLimits(overrides: Partial<Limits> = {}): Limits {
  return { max_actions: 100, ...overrides };
}

function baseApprovals(overrides: Partial<Approvals> = {}): Approvals {
  return { require_for: [], timeout_seconds: 60, ...overrides };
}

function baseCall(overrides: Partial<PolicyCall> = {}): PolicyCall {
  return { tool: "sheets.read", ...overrides };
}

describe("evaluatePolicy", () => {
  it("NO BINDING: denies with no_binding, checked before expiry, even on an also-expired lease", () => {
    const expiredLease = activeLease({ expiresAt: 500 });
    const result = evaluatePolicy(
      expiredLease,
      baseCall({ tool: "x" }),
      undefined,
      baseLimits(),
      baseApprovals(),
      999,
    );

    expect(result).toEqual({ decision: "deny", reason: "no_binding" });
  });

  it("CLASSIFICATION SOURCE: a manifest labeling the tool 'read' cannot override the binding's 'send' classification (PRXY-03)", () => {
    const sendBinding = readBinding({ tool: "email.send", access: "send" });
    // A manifest-like object mislabeling the same tool "read" — deliberately never
    // passed to evaluatePolicy. Its presence in this test proves the mislabel exists
    // and is irrelevant: evaluatePolicy's signature has no manifest parameter at all,
    // so classification can only ever come from `sendBinding.access` (PRXY-03).
    const manifestLikeMislabel = { tool: "email.send", access: "read" as const };
    expect(manifestLikeMislabel.access).not.toBe(sendBinding.access);

    const result = evaluatePolicy(
      activeLease(),
      baseCall({ tool: "email.send" }),
      sendBinding,
      baseLimits(),
      baseApprovals({ require_for: ["send"] }),
      500,
    );

    expect(result).toEqual({
      decision: "require_approval",
      requirement: { trigger: "send", binding: sendBinding },
    });
  });

  it("EXPIRY BOUNDARY: now = expiresAt - 1 allows; now = expiresAt denies; now = expiresAt + 1 denies", () => {
    const lease = activeLease({ expiresAt: 1000 });

    expect(
      evaluatePolicy(lease, baseCall(), readBinding(), baseLimits(), baseApprovals(), 999),
    ).toEqual({
      decision: "allow",
    });
    expect(
      evaluatePolicy(lease, baseCall(), readBinding(), baseLimits(), baseApprovals(), 1000),
    ).toEqual({
      decision: "deny",
      reason: "expired",
    });
    expect(
      evaluatePolicy(lease, baseCall(), readBinding(), baseLimits(), baseApprovals(), 1001),
    ).toEqual({
      decision: "deny",
      reason: "expired",
    });
  });

  it("MAX ACTIONS: actionCount === max_actions denies; max_actions - 1 does not", () => {
    const atCap = activeLease({
      counters: { actionCount: 10, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    });
    const belowCap = activeLease({
      counters: { actionCount: 9, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    });
    const limits = baseLimits({ max_actions: 10 });

    expect(evaluatePolicy(atCap, baseCall(), readBinding(), limits, baseApprovals(), 500)).toEqual({
      decision: "deny",
      reason: "over_max_actions",
    });
    expect(
      evaluatePolicy(belowCap, baseCall(), readBinding(), limits, baseApprovals(), 500),
    ).not.toEqual({
      decision: "deny",
      reason: "over_max_actions",
    });
  });

  it("SPEND: spentMinor 900 + call 200 over a 1000 cap denies; spentMinor 900 + call 100 does not", () => {
    const lease = activeLease({
      counters: { actionCount: 0, spentMinor: 900, denialErrorTimestamps: [], actionTimestamps: [] },
    });
    const limits = baseLimits({ spend: { amount_minor: 1000, currency: "usd" } });
    const payBinding = readBinding({ tool: "pay.tool", access: "pay" });

    const overResult = evaluatePolicy(
      lease,
      baseCall({ tool: "pay.tool", spendMinor: 200 }),
      payBinding,
      limits,
      baseApprovals(),
      500,
    );
    expect(overResult).toEqual({ decision: "deny", reason: "over_spend" });

    const underResult = evaluatePolicy(
      lease,
      baseCall({ tool: "pay.tool", spendMinor: 100 }),
      payBinding,
      limits,
      baseApprovals(),
      500,
    );
    expect(underResult).not.toEqual({ decision: "deny", reason: "over_spend" });
  });

  it("APPROVAL: a send binding with send in require_for requires approval with trigger 'send'", () => {
    const sendBinding = readBinding({ tool: "email.send", access: "send" });

    const result = evaluatePolicy(
      activeLease(),
      baseCall({ tool: "email.send" }),
      sendBinding,
      baseLimits(),
      baseApprovals({ require_for: ["send"] }),
      500,
    );

    expect(result).toEqual({
      decision: "require_approval",
      requirement: { trigger: "send", binding: sendBinding },
    });
  });

  it("APPROVAL: a pay binding with an EMPTY require_for still requires approval (pay always)", () => {
    const payBinding = readBinding({ tool: "pay.tool", access: "pay" });
    const limits = baseLimits({ spend: { amount_minor: 1000, currency: "usd" } });

    const result = evaluatePolicy(
      activeLease(),
      baseCall({ tool: "pay.tool", spendMinor: 50 }),
      payBinding,
      limits,
      baseApprovals({ require_for: [] }),
      500,
    );

    expect(result).toEqual({
      decision: "require_approval",
      requirement: { trigger: "pay", binding: payBinding },
    });
  });

  it("ALLOW: a read binding, within all limits, not expired, allows", () => {
    const result = evaluatePolicy(
      activeLease(),
      baseCall(),
      readBinding(),
      baseLimits(),
      baseApprovals(),
      500,
    );

    expect(result).toEqual({ decision: "allow" });
  });

  it("EMPTY COUNTERS: a fresh lease with zeroed counters and a call with no spend allows", () => {
    const freshLease = activeLease({
      counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    });

    const result = evaluatePolicy(
      freshLease,
      baseCall(),
      readBinding(),
      baseLimits(),
      baseApprovals(),
      500,
    );

    expect(result).toEqual({ decision: "allow" });
  });
});
