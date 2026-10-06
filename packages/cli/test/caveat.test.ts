import { describe, expect, it } from "vitest";

import type { Lease } from "@stint/core";
import type { ReceiptEntry } from "@stint/spec";

import {
  UNREVOKED_STATE_SUFFIX,
  isUnrevokedCleanup,
  leaseLabel,
  rotateCaveat,
  stateLabel,
  stuckReason,
  unrevokedResources,
} from "../src/render/caveat.js";

const ESC = String.fromCharCode(27);
const BIDI = String.fromCharCode(0x202e);

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "lease-c1",
    state: "cleaned_up",
    version: 5,
    boundHash: "jcs-sha256:deadbeef",
    grantedAt: 1,
    expiresAt: 2,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    teardownProgress: { revoke_oauth: "discarded_revocation_unsupported" },
    ...overrides,
  };
}

function step(payload: Record<string, unknown>, type: ReceiptEntry["type"] = "teardown_step"): ReceiptEntry {
  return { seq: 0, ts: 1, chain: "verified", type, payload, prevHash: "x" } as unknown as ReceiptEntry;
}

describe("stateLabel", () => {
  it("has the exact suffix wording", () => {
    expect(UNREVOKED_STATE_SUFFIX).toBe(" (credential not revoked upstream)");
  });

  it("labels cleaned_up with an unsupported revocation", () => {
    expect(stateLabel(lease())).toBe("cleaned_up (credential not revoked upstream)");
    expect(isUnrevokedCleanup(lease())).toBe(true);
  });

  it("leaves a fully revoked cleanup plain", () => {
    const l = lease({ teardownProgress: { revoke_oauth: "revoked" } });
    expect(stateLabel(l)).toBe("cleaned_up");
    expect(isUnrevokedCleanup(l)).toBe(false);
  });

  it("never labels a lease that is not cleaned_up", () => {
    expect(stateLabel(lease({ state: "cleanup_incomplete" }))).toBe("cleanup_incomplete");
    expect(stateLabel(lease({ state: "active", teardownProgress: undefined }))).toBe("active");
  });
});

describe("unrevokedResources", () => {
  it("returns an empty array for an empty chain", () => {
    expect(unrevokedResources([])).toEqual([]);
  });

  it("returns unique, ascending-sorted resources of unsupported revoke_oauth steps only", () => {
    const entries = [
      step({ step: "revoke_oauth", outcome: "discarded_revocation_unsupported", resource: "zeta" }),
      step({ step: "revoke_oauth", outcome: "revoked", resource: "alpha" }),
      step({ step: "revoke_oauth", outcome: "discarded_revocation_unsupported", resource: "beta" }),
      step({ step: "revoke_oauth", outcome: "discarded_revocation_unsupported", resource: "zeta" }),
      step({ step: "revoke_oauth", outcome: "failed", resource: "gamma" }),
      step({ step: "cleanup_hook", outcome: "discarded_revocation_unsupported", resource: "delta" }),
    ];
    expect(unrevokedResources(entries)).toEqual(["beta", "zeta"]);
  });

  it("ignores entries without a string resource and non-teardown entries", () => {
    const entries = [
      step({ step: "revoke_oauth", outcome: "discarded_revocation_unsupported" }),
      step({ step: "revoke_oauth", outcome: "discarded_revocation_unsupported", resource: 7 }),
      step(
        { step: "revoke_oauth", outcome: "discarded_revocation_unsupported", resource: "x" },
        "call",
      ),
    ];
    expect(unrevokedResources(entries)).toEqual([]);
  });
});

describe("rotateCaveat", () => {
  it("uses the fixed sentence", () => {
    expect(rotateCaveat("sheets.orders")).toBe(
      "The credential for sheets.orders was not revoked upstream. Rotate it in the provider dashboard.",
    );
  });

  it("sanitizes the resource name (T-08-05)", () => {
    const out = rotateCaveat(`a${ESC}[31mb${BIDI}c\nforged`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BIDI);
    expect(out).not.toContain("\n");
    expect(out).toContain("ab");
  });
});

describe("stuckReason", () => {
  const stuck = (reason: unknown): ReceiptEntry => step({ reason, attempts: 0 }, "teardown_stuck");
  const incomplete = (): ReceiptEntry =>
    step({ from: "tearing_down", event: "teardown_incomplete", actor: "runtime", to: "cleanup_incomplete" }, "transition");
  const blocked = (): ReceiptEntry =>
    step({ reason: "credentials_unavailable", resources: ["sheets.orders"] }, "teardown_blocked");

  it("returns the reason of a trailing teardown_stuck", () => {
    expect(stuckReason([incomplete(), stuck("retries_exhausted")])).toBe("retries_exhausted");
    for (const reason of ["credentials_unavailable", "retries_exhausted", "revocation_failed", "manifest_invalid"]) {
      expect(stuckReason([stuck(reason)])).toBe(reason);
    }
  });

  it("returns undefined for an empty chain", () => {
    expect(stuckReason([])).toBeUndefined();
  });

  it("is cleared by a later teardown_incomplete transition", () => {
    expect(stuckReason([stuck("retries_exhausted"), incomplete()])).toBeUndefined();
  });

  it("is cleared by a later teardown_blocked entry", () => {
    expect(stuckReason([stuck("retries_exhausted"), blocked()])).toBeUndefined();
  });

  it("is set again by a stuck entry that follows a clearing one", () => {
    expect(stuckReason([stuck("retries_exhausted"), incomplete(), stuck("revocation_failed")])).toBe(
      "revocation_failed",
    );
  });

  it("returns undefined for an unknown reason string, never echoing it", () => {
    expect(stuckReason([stuck("because I said so")])).toBeUndefined();
    expect(stuckReason([stuck(42)])).toBeUndefined();
    expect(stuckReason([stuck("retries_exhausted"), stuck("because I said so")])).toBeUndefined();
  });

  it("ignores a malformed payload", () => {
    expect(stuckReason([step({ nope: true } as Record<string, unknown>, "teardown_stuck")])).toBeUndefined();
    expect(stuckReason([{ ...stuck("retries_exhausted"), payload: null } as unknown as ReceiptEntry])).toBeUndefined();
  });
});

describe("leaseLabel", () => {
  const stuckEntry = (reason: string): ReceiptEntry => step({ reason, attempts: 0 }, "teardown_stuck");

  it("labels an expired lease with its stuck reason", () => {
    expect(leaseLabel(lease({ state: "expired", teardownProgress: undefined }), [stuckEntry("credentials_unavailable")])).toBe(
      "expired (stuck: credentials_unavailable)",
    );
  });

  it("labels a cleanup_incomplete lease with its stuck reason", () => {
    expect(leaseLabel(lease({ state: "cleanup_incomplete" }), [stuckEntry("retries_exhausted")])).toBe(
      "cleanup_incomplete (stuck: retries_exhausted)",
    );
  });

  it("gives a cleaned_up lease the plain state label even with an old stuck entry", () => {
    expect(leaseLabel(lease(), [stuckEntry("retries_exhausted")])).toBe("cleaned_up (credential not revoked upstream)");
    expect(leaseLabel(lease({ teardownProgress: { revoke_oauth: "revoked" } }), [stuckEntry("retries_exhausted")])).toBe(
      "cleaned_up",
    );
  });

  it("is the plain state label when nothing is stuck or the reason is unknown", () => {
    expect(leaseLabel(lease({ state: "expired", teardownProgress: undefined }), [])).toBe("expired");
    expect(leaseLabel(lease({ state: "expired", teardownProgress: undefined }), [stuckEntry("nope")])).toBe("expired");
  });
});
