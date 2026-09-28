import { describe, expect, it } from "vitest";

import {
  PACKAGE_NAME,
  SPEC_VERSION,
  CORE_ERROR_CODES,
  TRANSITION_TABLE,
  reduce,
  evaluatePolicy,
  checkErrorThreshold,
  POLICY_REASON_CODES,
  createBindingSet,
  resolveBinding,
  verifyBoundHash,
  activateLease,
  resumeLease,
  awaitApprovalDecision,
  userEvents,
  runtimeEvents,
  needsRefresh,
  clampedLicenseExpiry,
  DEFAULT_LICENSE_TTL_SECONDS,
  verifyLicense,
  LICENSE_CLOCK_SKEW_SECONDS,
  readLicenseToken,
  LICENSE_VERIFY_REASONS,
} from "../src/index.js";
import type {
  Lease,
  HostAdapter,
  LeaseStore,
  PolicyDecision,
  ConnectorBinding,
  HeldLicense,
  LicenseIssuer,
  LicenseClaims,
  VerifiedLicense,
} from "../src/index.js";

describe("@stint/core public API surface (HOST-01)", () => {
  it("exports every Phase 2 function from the barrel", () => {
    expect(typeof reduce).toBe("function");
    expect(typeof evaluatePolicy).toBe("function");
    expect(typeof checkErrorThreshold).toBe("function");
    expect(typeof createBindingSet).toBe("function");
    expect(typeof resolveBinding).toBe("function");
    expect(typeof verifyBoundHash).toBe("function");
    expect(typeof activateLease).toBe("function");
    expect(typeof resumeLease).toBe("function");
    expect(typeof awaitApprovalDecision).toBe("function");
  });

  it("exports the actor-namespaced event constructor namespaces", () => {
    expect(typeof userEvents).toBe("object");
    expect(typeof userEvents.consentGranted).toBe("function");
    expect(typeof runtimeEvents).toBe("object");
    expect(typeof runtimeEvents.activate).toBe("function");
  });

  it("exports the stable data tables/vocabularies", () => {
    expect(TRANSITION_TABLE).toBeDefined();
    expect(POLICY_REASON_CODES).toBeDefined();
    expect(CORE_ERROR_CODES).toBeDefined();
    expect(Array.isArray(POLICY_REASON_CODES)).toBe(true);
    expect(Array.isArray(CORE_ERROR_CODES)).toBe(true);
  });

  it("preserves SPEC_VERSION and PACKAGE_NAME", () => {
    expect(SPEC_VERSION).toBe("alp/0.1");
    expect(PACKAGE_NAME).toBe("@stint/core");
  });

  it("does not export the in-memory LeaseStore test double from the public entry (D-14)", async () => {
    const barrel = (await import("../src/index.js")) as Record<string, unknown>;
    expect(barrel.createInMemoryLeaseStore).toBeUndefined();
    expect(barrel.createLeaseStoreContractTests).toBeUndefined();
  });

  it("compiles type-only imports of the core contract shapes", () => {
    // Compile-time-only check: if any of these types were removed from the
    // barrel, this file would fail to type-check.
    const typeCheck: {
      lease?: Lease;
      hostAdapter?: HostAdapter;
      leaseStore?: LeaseStore;
      policyDecision?: PolicyDecision;
      connectorBinding?: ConnectorBinding;
    } = {};
    expect(typeCheck).toEqual({});
  });

  it("exports the license public surface (LIC-03, D-11, D-15)", () => {
    expect(typeof needsRefresh).toBe("function");
    expect(typeof clampedLicenseExpiry).toBe("function");
    expect(typeof verifyLicense).toBe("function");
    expect(typeof readLicenseToken).toBe("function");
    expect(DEFAULT_LICENSE_TTL_SECONDS).toBe(300);
    expect(LICENSE_CLOCK_SKEW_SECONDS).toBe(5);
    expect(Array.isArray(LICENSE_VERIFY_REASONS)).toBe(true);
  });

  it("does not export issueLicense or the mock LicenseIssuer from the main entry (D-11, D-14)", async () => {
    const barrel = (await import("../src/index.js")) as Record<string, unknown>;
    expect(barrel.issueLicense).toBeUndefined();
    expect(barrel.createMockLicenseIssuer).toBeUndefined();
  });

  it("compiles type-only imports of the license contract shapes", () => {
    // Compile-time-only check: if any of these types were removed from the
    // barrel, this file would fail to type-check.
    const typeCheck: {
      heldLicense?: HeldLicense;
      licenseIssuer?: LicenseIssuer;
      licenseClaims?: LicenseClaims;
      verifiedLicense?: VerifiedLicense;
    } = {};
    expect(typeCheck).toEqual({});
  });
});
