/**
 * `handleCall` -- the single `tools/call` dispatch point every call flows
 * through, allowed, denied, or naming a hidden/unbound tool directly
 * (PRXY-01, T-04-02-DN). It never contains policy logic itself (PEP/PDP
 * split): it resolves the runtime-owned binding, decides via the pure
 * `evaluatePolicy`, then runs the ENTIRE authorize -> execute -> receipt
 * flow inside one per-lease transaction (`runInLeaseTransaction`, D-13) so
 * the receipt append lands in the same serialized step as the counters it
 * mutates, and chain order matches call order.
 *
 * `ExecuteStage`, `ApprovalStage`, and `CapEnforcer` are the three injected
 * seams plan 04-05 (vault-backed execute), 04-04 (real out-of-band
 * approvals), and 04-03 (sliding-window actions_per_hour) implement
 * against, without editing this file.
 */

import { evaluatePolicy, resolveBinding } from "@stint/core";
import type {
  ApprovalRequirement,
  BindingSet,
  ConnectorBinding,
  Lease,
  PolicyCall,
} from "@stint/core";
import type { Access, Limits } from "@stint/spec";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { runInLeaseTransaction } from "./concurrency/lease-serializer.js";
import { appendCallReceipt, buildCallPayload } from "./receipts/call-receipt.js";
import type { ProxyDeps } from "./server.js";

/**
 * One resolved call's context, handed to the three injected seams below.
 * Only ever constructed once a `binding` is known to exist --
 * `evaluatePolicy`'s Step 1 already denies `no_binding` otherwise, so a
 * `CallContext` never carries an absent binding.
 */
export interface CallContext {
  readonly leaseId: string;
  readonly tool: string;
  readonly resolvedArgs: Readonly<Record<string, unknown>>;
  readonly binding: ConnectorBinding;
}

/** The outbound execution seam (D-01/D-02) -- plan 04-05 supplies the real vault-backed implementation. */
export interface ExecuteStage {
  execute(ctx: CallContext): Promise<{ readonly status: number; readonly body: unknown }>;
}

/** The out-of-band approval decision for `send`/`pay`/`irreversible` calls (D-11, PRXY-05). Deny-by-default. */
export interface ApprovalDecision {
  readonly decision: "approve" | "deny";
  readonly reason?: string;
}

/** Requests an out-of-band approval for a call `evaluatePolicy` flagged `require_approval` -- plan 04-04 supplies the real HostAdapter-backed implementation (`awaitApprovalDecision` + a real `AbortSignal` timeout). */
export interface ApprovalStage {
  requestApproval(ctx: CallContext, requirement: ApprovalRequirement, now: number): Promise<ApprovalDecision>;
}

/** The result of an additional lease-limit check beyond `evaluatePolicy`'s own (e.g. the actions_per_hour sliding window, PRXY-04). */
export interface CapCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * An additional lease-limit check plus the counters commit for an allowed
 * call (D-06, PRXY-04). `authorize` receives `limits` directly (the
 * `actions_per_hour` gate it alone enforces, `evaluatePolicy` already owns
 * `max_actions`/`spend`/`expiry`/`no_binding`); `commit` receives the whole
 * `lease` and returns the next one -- the real `createCapEnforcer`
 * (`caps/cap-enforcer.ts`, plan 04-03) is the sliding-window implementation
 * of this seam.
 */
export interface CapEnforcer {
  authorize(lease: Lease, call: PolicyCall, limits: Limits, now: number): CapCheck;
  commit(lease: Lease, call: PolicyCall, now: number): Lease;
}

/** Production-safe default `ExecuteStage`: no `OutboundConnector` is configured until plan 04-05 wires the vault-backed implementation. */
export const DEFAULT_EXECUTE_STAGE: ExecuteStage = {
  execute() {
    return Promise.reject(new Error("@stint/proxy: no OutboundConnector configured."));
  },
};

/** Production-safe default `ApprovalStage`: deny-by-default until plan 04-04 wires the real out-of-band HostAdapter path. */
export const DEFAULT_APPROVAL_STAGE: ApprovalStage = {
  requestApproval() {
    return Promise.resolve({ decision: "deny", reason: "no ApprovalStage configured" });
  },
};

/** Production-safe default `CapEnforcer`: authorizes every call (no additional limit beyond `evaluatePolicy`'s own checks) and commits the actionCount/actionTimestamps bump (D-06) -- plan 04-03's `createCapEnforcer` (`caps/cap-enforcer.ts`) is the real sliding-window `authorize` a production `ProxyDeps` should use instead. */
export const DEFAULT_CAP_ENFORCER: CapEnforcer = {
  authorize() {
    return { ok: true };
  },
  commit(lease, call, now) {
    return {
      ...lease,
      counters: {
        ...lease.counters,
        actionCount: lease.counters.actionCount + 1,
        actionTimestamps: [...lease.counters.actionTimestamps, now],
      },
    };
  },
};

/**
 * Resolves `tool`'s runtime-owned binding, collapsing to `undefined` --
 * which drives `evaluatePolicy`'s deny-by-default `no_binding` reason --
 * whenever the tool has no binding at all OR its binding exists but is out
 * of this lease's granted scope/resource. This is the ONLY binding
 * resolution path both `tools/list`'s visibility filter (`server.ts`) and
 * `tools/call`'s authorization (`handleCall` below) use, so a tool hidden
 * from `tools/list` can never be reached by naming it directly
 * (T-04-02-DN) -- there is exactly one place this "unbound-or-out-of-scope"
 * collapse happens, not two that could silently drift apart.
 */
export function resolveEffectiveBinding(
  bindings: BindingSet,
  grantedScopes: readonly Access[],
  grantedResources: readonly string[],
  tool: string,
): ConnectorBinding | undefined {
  const binding = resolveBinding(bindings, tool);
  if (binding === undefined) return undefined;
  if (!grantedScopes.includes(binding.access)) return undefined;
  if (!grantedResources.includes(binding.resource)) return undefined;
  return binding;
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function denyResult(reason: string): CallToolResult {
  return textResult(`denied: ${reason}`, true);
}

function allowResult(execResult: { readonly status: number; readonly body: unknown }): CallToolResult {
  return textResult(JSON.stringify(execResult.body), false);
}

function errorResult(): CallToolResult {
  // Deliberately generic -- never echoes the underlying error's message,
  // which could carry args/credential material from a connector (D-13).
  return textResult("call failed", true);
}

/**
 * The one dispatch point every `tools/call` (allowed, denied, or naming a
 * hidden/unbound tool directly) flows through. Resolves args
 * (`params.arguments ?? {}`), resolves the effective binding, then runs
 * authorize -> execute -> receipt entirely inside one per-lease
 * transaction so the receipt append happens in the same serialized step as
 * the counters it mutates (D-13). The receipt is appended in a `finally`
 * block so a thrown `execute` never skips it.
 */
export async function handleCall(
  deps: ProxyDeps,
  params: { readonly name: string; readonly arguments?: Readonly<Record<string, unknown>> },
  now: number,
): Promise<CallToolResult> {
  const resolvedArgs: Record<string, unknown> = { ...(params.arguments ?? {}) };
  const binding = resolveEffectiveBinding(deps.bindings, deps.grantedScopes, deps.grantedResources, params.name);

  let result: CallToolResult | undefined;

  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    let nextLease = lease;
    let outcome: "allowed" | "denied" = "denied";
    let detail: string | undefined;

    try {
      const call: PolicyCall = { tool: params.name, spendMinor: undefined };
      const decision = evaluatePolicy(lease, call, binding, deps.limits, deps.approvals, now);

      if (decision.decision === "deny") {
        detail = decision.reason;
        result = denyResult(detail);
        return nextLease;
      }

      // Invariant: `evaluatePolicy` only reaches `require_approval`/`allow`
      // when its own Step 1 resolved a real binding.
      if (binding === undefined) {
        throw new Error(
          "@stint/proxy: invariant violated -- evaluatePolicy returned a non-deny decision with no binding.",
        );
      }
      const ctx: CallContext = { leaseId: deps.leaseId, tool: params.name, resolvedArgs, binding };

      if (decision.decision === "require_approval") {
        const approval = await deps.approve.requestApproval(ctx, decision.requirement, now);
        if (approval.decision === "deny") {
          detail = approval.reason ?? "approval_denied";
          result = denyResult(detail);
          return nextLease;
        }
      }

      const capCheck = deps.enforceCaps.authorize(lease, call, deps.limits, now);
      if (!capCheck.ok) {
        detail = capCheck.reason ?? "cap_exceeded";
        result = denyResult(detail);
        return nextLease;
      }

      const execResult = await deps.execute.execute(ctx);
      outcome = "allowed";
      result = allowResult(execResult);
      nextLease = deps.enforceCaps.commit(lease, call, now);
      return nextLease;
    } catch {
      outcome = "denied";
      detail = "execute_failed";
      result = errorResult();
      return nextLease;
    } finally {
      const chain = await deps.receiptStore.load("verified");
      const payload = buildCallPayload(binding, resolvedArgs, outcome, detail);
      await appendCallReceipt(deps.receiptStore, chain, payload, now);
    }
  });

  if (result === undefined) {
    // unreachable: every path above sets `result` before returning from the mutator.
    throw new Error("@stint/proxy: handleCall produced no result.");
  }
  return result;
}
