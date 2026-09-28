export { SPEC_VERSION } from "@stint/spec";
export { PACKAGE_NAME as CORE_PACKAGE_NAME } from "@stint/core";

export const PACKAGE_NAME = "@stint/proxy";

// Agent-facing MCP server (PRXY-01, D-08, D-10). `createLeaseProxyServer`
// constructs one low-level `Server` per lease; `ProxyDeps` is every
// construction-time dependency it and `handleCall` (dispatch.ts) need.
export { createLeaseProxyServer } from "./server.js";
export type { ProxyDeps } from "./server.js";

// Dispatch seams (PRXY-01, D-01, D-06, D-11, D-13). `ExecuteStage`,
// `ApprovalStage`, and `CapEnforcer` are the three injected seams a
// platform/publisher-facing implementation composes into `ProxyDeps`;
// `CallContext` is what each seam receives. The `DEFAULT_*` constants are
// the production-safe placeholders `ProxyDeps` uses until plans 04-03
// (sliding-window caps), 04-04 (real out-of-band approvals), and 04-05
// (vault-backed execute) supply the real implementations.
export {
  DEFAULT_APPROVAL_STAGE,
  DEFAULT_CAP_ENFORCER,
  DEFAULT_EXECUTE_STAGE,
  handleCall,
} from "./dispatch.js";
export type {
  ApprovalDecision,
  ApprovalStage,
  CallContext,
  CapCheck,
  CapEnforcer,
  ExecuteStage,
} from "./dispatch.js";

// Runtime-owned tool catalog (D-08, D-12) -- paired with (never merged
// into) `@stint/core`'s `BindingSet` for `tools/list`'s agent-facing
// presentation. `extractSpendMinor` and `ToolCatalogEntry.payAmount` are the
// PRXY-04 pay-amount descriptor (D-07): the runtime-owned, pre-authorization
// spend source `dispatch.ts` extracts before `evaluatePolicy` runs.
export { createToolCatalog, extractSpendMinor, resolveCatalogEntry } from "./catalog.js";
export type { ToolCatalog, ToolCatalogEntry } from "./catalog.js";

// Sliding-window cap enforcement (PRXY-04, D-05, D-06). `createCapEnforcer`
// is the real `CapEnforcer` implementation -- the production value a
// `ProxyDeps.enforceCaps` should be constructed with; `DEFAULT_CAP_ENFORCER`
// (above) stays a naive placeholder for callers that haven't wired real caps.
export { createCapEnforcer } from "./caps/cap-enforcer.js";

// Out-of-band approvals (PRXY-05, D-11). `createApprovalDispatcher` is the
// real `ApprovalStage` implementation -- the production value a
// `ProxyDeps.approve` should be constructed with (a real `HostAdapter` +
// `manifest.approvals.timeout_seconds`); `DEFAULT_APPROVAL_STAGE` (above)
// stays a deny-by-default placeholder. `computeApprovalHash` is the single
// D-11 commitment-hash function (`hashCanonical({ args, tool, provenance,
// leaseVersion })`) -- exported so a platform can independently verify a
// receipted approval's commitment offline.
export { computeApprovalHash, createApprovalDispatcher } from "./approvals/approval-dispatcher.js";
export type { PendingApproval } from "./approvals/approval-dispatcher.js";

// Per-call receipt builder (D-13, RCPT-01). `buildCallPayload` produces the
// secretless `CallPayload` (re-exported from `@stint/core`); `appendCallReceipt`
// is the sole append path for a `type: "call"` verified-chain entry.
export { appendCallReceipt, buildCallPayload } from "./receipts/call-receipt.js";

// Credential vault refresh hot path (D-02, D-04, D-09, PRXY-08).
// `createCredentialVault` is the secretless token store keyed
// `leaseId:resource` with per-call expiry and per-credential single-flight
// refresh; `refreshAccessToken`/`classifyTokenError` are the underlying
// `oauth4webapi` refresh-grant + D-09 revocation-signal classification
// `createCredentialVault` composes. `CredentialRefreshError`'s `.kind`
// (`"provider_revoked" | "transient_error"`) is the classification 04-07's
// revocation wiring consumes.
export { classifyTokenError, refreshAccessToken } from "./vault/oauth-client.js";
export type { OAuthClient, RefreshOptions, RefreshResult, SeededCredential } from "./vault/oauth-client.js";
export { createCredentialVault, CredentialRefreshError } from "./vault/credential-vault.js";
export type { CredentialVault } from "./vault/credential-vault.js";

// Downstream execution port + credential scrubber (D-01, D-02, PRXY-06,
// LIC-05). `OutboundConnector` is the injected downstream-execution port --
// no enforcement-path code imports `createRestOutboundConnector` (the
// reference REST implementation) directly, it is always constructor-
// injected. `createVaultExecuteStage` is the real, vault-backed `ExecuteStage`
// (dispatch.ts's seam): it resolves the access token from the credential
// vault, hands it to the injected port as `{ accessToken }` only -- never
// the publisher license -- and wraps the port call in `scrubCredential` so
// no token can cross the agent-facing boundary in a response or an error.
export { createRestOutboundConnector } from "./connectors/outbound-connector.js";
export type { FetchLike, OutboundConnector, OutboundCredential } from "./connectors/outbound-connector.js";
export { scrubCredential, scrubError } from "./vault/scrub.js";
export { createVaultExecuteStage } from "./vault/execute-stage.js";
export type { LicenseAccessor } from "./vault/execute-stage.js";

// Lazy customer-side OAuth revocation detection (D-09, PRXY-07), retrofitted
// (05-03, D-18, TEAR-01) to auto-chain into the teardown orchestrator.
// `applyProviderRevocation` chains `reduce()` + `providerEvents.grantRevoked()`
// then `chainTeardownIfEnded`'s `begin_teardown`, landing `tearing_down`;
// `dispatch.ts`'s `provider_revoked` catch branch applies it to the
// transaction-loaded lease. `isProviderRevocation` is the transient-vs-
// revocation discriminator reused at that same call site.
export { applyProviderRevocation, isProviderRevocation } from "./revocation.js";

// Teardown orchestrator (05-03, TEAR-01, TEAR-04, TEAR-05). `runTeardown`
// auto-chains `begin_teardown` from any terminal end state via the shared
// `chainTeardownIfEnded` helper, walks the fixed 5 steps under the per-lease
// serializer, persists per-step progress, and lands `cleaned_up`/
// `cleanup_incomplete`; `retryTeardown` is the explicit-only recovery path
// from `cleanup_incomplete`. `TeardownStep`/`createDefaultTeardownSteps` are
// the injectable per-step port and its production happy-path defaults
// (hardened by 05-04/05-05/05-06); `TeardownDeps` is `runTeardown`'s/
// `retryTeardown`'s construction-time dependency bag.
export { chainTeardownIfEnded } from "./teardown/auto-chain.js";
export { appendTransitionReceipt, retryTeardown, runTeardown } from "./teardown/orchestrate.js";
export type { TeardownDeps } from "./teardown/orchestrate.js";
export { createDefaultTeardownSteps, runStepOnce, TEARDOWN_STEP_ORDER } from "./teardown/steps.js";
export type { TeardownStep } from "./teardown/steps.js";
export {
  allStepsSucceeded,
  isSuccessOutcome,
  recordStepOutcome,
  remainingSteps,
} from "./teardown/progress.js";

// `@stint/proxy/testing` (mock `ExecuteStage`s, contract-test factories for
// proxy-owned stores) is deliberately NOT re-exported here -- production
// code must never accidentally depend on a test double.
