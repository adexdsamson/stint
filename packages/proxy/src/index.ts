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
// presentation.
export { createToolCatalog, resolveCatalogEntry } from "./catalog.js";
export type { ToolCatalog, ToolCatalogEntry } from "./catalog.js";

// Per-call receipt builder (D-13, RCPT-01). `buildCallPayload` produces the
// secretless `CallPayload` (re-exported from `@stint/core`); `appendCallReceipt`
// is the sole append path for a `type: "call"` verified-chain entry.
export { appendCallReceipt, buildCallPayload } from "./receipts/call-receipt.js";

// `@stint/proxy/testing` (mock `ExecuteStage`s, contract-test factories for
// proxy-owned stores) is deliberately NOT re-exported here -- production
// code must never accidentally depend on a test double.
