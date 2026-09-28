export { SPEC_VERSION } from "@stint/spec";

export const PACKAGE_NAME = "@stint/core";

export { CORE_ERROR_CODES } from "./errors.js";
export type { CoreError, CoreErrorCode, Result } from "./errors.js";

export { TRANSITION_TABLE, STATES, EVENTS, ACTORS } from "./transitions.js";
export type { State, Event, Actor } from "./transitions.js";

export { userEvents, clockEvents, policyEvents, providerEvents, publisherEvents, verifierEvents, runtimeEvents } from "./events.js";
export type { LeaseEvent } from "./events.js";

export { reduce } from "./lease.js";
export type { Lease, LeaseCounters, TransitionRecord } from "./lease.js";

export { createBindingSet, resolveBinding } from "./bindings.js";
export type { ConnectorBinding, BindingSet, BindingProvenance } from "./bindings.js";

export { POLICY_REASON_CODES, evaluatePolicy, checkErrorThreshold } from "./policy.js";
export type { PolicyDecision, PolicyReason, PolicyCall, ApprovalRequirement } from "./policy.js";

export { verifyBoundHash } from "./hash-guard.js";

export { activateLease, resumeLease } from "./activate.js";

export { awaitConsentDecision, awaitApprovalDecision } from "./host-adapter.js";
export type {
  HostAdapter,
  LifecycleEvent,
  ConsentRequest,
  ConsentDecision,
  ApprovalRequest,
  ApprovalDecision,
} from "./host-adapter.js";

export type { LeaseStore, LeaseMutator } from "./lease-store.js";

// License public surface (LIC-01, LIC-02, LIC-03, D-11, D-13, D-15). The
// reference `issueLicense` secret-signing path and `@stint/core/testing`'s
// `createMockLicenseIssuer` are deliberately NOT re-exported here -- the
// runtime depends on the injected `LicenseIssuer` port, never signs directly
// (D-11), and the mock issuer stays testing-only (D-14's `./testing` rule).
export { needsRefresh, clampedLicenseExpiry, DEFAULT_LICENSE_TTL_SECONDS } from "./license/refresh.js";
export { verifyLicense, LICENSE_CLOCK_SKEW_SECONDS } from "./license/verify.js";
export type { VerifiedLicense } from "./license/verify.js";
export type { LicenseClaims, LicenseJobClaim, LicenseLimitsClaim } from "./license/issue.js";
export { readLicenseToken } from "./license/held-license.js";
export type { HeldLicense } from "./license/held-license.js";
export type { LicenseIssuer } from "./license/license-issuer.js";
export { LICENSE_VERIFY_REASONS } from "./license/errors.js";
export type { LicenseVerifyReason } from "./license/errors.js";
