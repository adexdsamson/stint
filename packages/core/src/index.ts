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
