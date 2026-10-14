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
 * seams plan 04-06 (vault-backed execute) and 04-04 (real out-of-band
 * approvals) implement against without editing this file's dispatch flow.
 * Plans 04-03 (sliding-window `actions_per_hour`, PRXY-04) and 04-06
 * (vault-backed execute, PRXY-06/LIC-05) each required a minimal, additive
 * seam signature extension -- 04-03's `CapEnforcer.authorize` gains
 * `limits`, `commit` takes the whole `lease`+`call` and returns the next
 * `Lease`; 04-06's `ExecuteStage.execute` gains an explicit `now` parameter
 * so the vault-backed implementation resolves tokens against the injected
 * clock, never `Date.now()` -- the dispatch ORDER (evaluate -> approve ->
 * authorize caps -> execute -> commit, receipt in a `finally`) is unchanged
 * by either. `handleCall` also extracts a pay call's `spendMinor`
 * pre-authorization from the runtime-owned catalog (D-07) via
 * `extractSpendMinor`, before `evaluatePolicy` runs.
 *
 * 04-07 (PRXY-07, D-09): `execute()` can reject with the 04-05 vault's
 * `CredentialRefreshError` (`kind: "provider_revoked" | "transient_error"`).
 * The catch block below classifies it BEFORE falling through to the
 * generic `execute_failed` path -- `provider_revoked` applies
 * `revocation.ts`'s `applyProviderRevocation` to the transaction-loaded
 * `lease` (saving `tearing_down` -- `grant_revoked` actor `provider`
 * auto-chained into `begin_teardown` actor `runtime`, D-18, TEAR-01) and
 * denies the triggering call; `transient_error` denies the call and returns
 * `lease` UNCHANGED, so a single upstream blip never revokes.
 *
 * 05-03 (TEAR-01, D-18, D-30): once `applyProviderRevocation`'s two
 * transition receipts and the triggering call's `denied` receipt are all
 * appended inside the SAME per-lease transaction as before, `handleCall`
 * checks -- AFTER that transaction resolves -- whether the lease is now in
 * a teardown state and, if `deps.teardownSteps` is configured, runs
 * `teardown/orchestrate.ts`'s `runTeardown` in its OWN, separate per-lease
 * transaction. This is never nested on the same lease id: the outer
 * transaction has already committed and released the per-id serializer
 * queue slot by the time `runTeardown` opens its own.
 */

import { createLeaseEndedReason, evaluatePolicy, resolveBinding, safeEmit } from "@stint/core";
import type {
  ApprovalRequirement,
  ApprovalVoidReason,
  BindingSet,
  ConnectorBinding,
  Lease,
  PolicyCall,
} from "@stint/core";
import { hashCanonical } from "@stint/spec";
import type { Access, ContentHash, Limits } from "@stint/spec";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { computeApprovalHash } from "./approvals/approval-dispatcher.js";
import { extractSpendMinor, resolveCatalogEntry } from "./catalog.js";
import { runInLeaseTransaction } from "./concurrency/lease-serializer.js";
import { appendCallReceipt, buildCallPayload } from "./receipts/call-receipt.js";
import { applyProviderRevocation, isProviderRevocation } from "./revocation.js";
import { TeardownFencedError } from "./teardown/fence.js";
import { appendTransitionReceipt, runTeardown } from "./teardown/orchestrate.js";
import { CredentialRefreshError } from "./vault/credential-vault.js";
import type { ProxyDeps } from "./server.js";

/** Lease states reachable at the end of `handleCall`'s transaction that mean "teardown should run now" (05-03, TEAR-01). */
const TEARDOWN_TRIGGER_STATES: ReadonlySet<Lease["state"]> = new Set(["tearing_down", "cleanup_incomplete"]);

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
  /** The lease's `version` at the moment this `CallContext` was built (D-11) -- part of the approval commitment tuple `createApprovalDispatcher` hashes against. */
  readonly leaseVersion: number;
}

/**
 * The outbound execution seam (D-01/D-02) -- plan 04-06 supplies the real
 * vault-backed implementation (`vault/execute-stage.ts`'s
 * `createVaultExecuteStage`). `now` is threaded through explicitly (widened
 * from the 04-02 zero-arg signature, mirroring 04-03's `CapEnforcer` and
 * 04-04's `ApprovalStage` widening precedent) because the vault-backed
 * implementation resolves a token against the injected clock, never
 * `Date.now()` -- no internal timers, no implicit "now" source, matching
 * the credential vault's own per-call-expiry discipline (D-04). Existing
 * implementations that ignore `now` (`DEFAULT_EXECUTE_STAGE`,
 * `testing.ts`'s `createEchoExecuteStage`) remain valid without
 * modification -- a function with fewer declared parameters than an
 * interface method still satisfies it.
 */
export interface ExecuteStage {
  execute(ctx: CallContext, now: number): Promise<{ readonly status: number; readonly body: unknown }>;
}

/**
 * The out-of-band approval decision for `send`/`pay`/`irreversible` calls
 * (D-11, PRXY-05). Deny-by-default. `approvalId` is present only on
 * `approve` -- the opaque handle `handleCall` passes to
 * `ApprovalStage.verifyCommitment` to recompute-and-match the commitment
 * hash against the CURRENT args/binding/lease-version before the call is
 * allowed to proceed.
 */
export interface ApprovalDecision {
  readonly decision: "approve" | "deny";
  readonly reason?: string;
  readonly approvalId?: string;
}

/**
 * Requests an out-of-band approval for a call `evaluatePolicy` flagged
 * `require_approval` -- `createApprovalDispatcher`
 * (`approvals/approval-dispatcher.ts`, plan 04-04) supplies the real
 * HostAdapter-backed implementation (`awaitApprovalDecision` + a real
 * `AbortSignal` timeout). `verifyCommitment` is the ONLY way `handleCall`
 * checks a held approval's commitment hash for an exact match against the
 * CURRENT args + binding + lease version at execution time (D-11) -- any
 * drift denies the reused approval as a new request.
 */
export interface ApprovalStage {
  requestApproval(
    ctx: CallContext,
    requirement: ApprovalRequirement,
    now: number,
    opts?: ApprovalRequestOptions,
  ): Promise<ApprovalDecision>;
  verifyCommitment(approvalId: string, currentHash: ContentHash): boolean;
  /** Drops a held commitment that will never be verified (the post-approval transaction failed before it ran). Optional so existing stages stay valid. */
  release?(approvalId: string): void;
  /** Tells the user an approval they gave did not take effect (D-21). Best effort: it must never throw and never changes the call's result. */
  reportVoided?(ctx: CallContext, reason: ApprovalVoidReason, now: number): Promise<void>;
}

/**
 * Per-request options for `ApprovalStage.requestApproval`. `signal` is the
 * lease-ended signal `handleCall` aborts when the lease ends during the wait
 * (D-20); a stage merges it with its own timeout.
 */
export interface ApprovalRequestOptions {
  readonly signal?: AbortSignal;
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

/** Production-safe default `ExecuteStage`: no `OutboundConnector` is configured until plan 04-06 wires the vault-backed implementation. */
export const DEFAULT_EXECUTE_STAGE: ExecuteStage = {
  execute() {
    return Promise.reject(new Error("@stint/proxy: no OutboundConnector configured."));
  },
};

/** Production-safe default `ApprovalStage`: deny-by-default -- never approves, so `verifyCommitment` is never meaningfully called, but the interface requires an implementation (always `false`, matching the deny-by-default discipline). */
export const DEFAULT_APPROVAL_STAGE: ApprovalStage = {
  requestApproval() {
    return Promise.resolve({ decision: "deny", reason: "no ApprovalStage configured" });
  },
  verifyCommitment() {
    return false;
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

/** The fixed name of the agent signal tool (Phase 10, SPEC-11). Not a catalog entry: no binding, no counter, no limit. */
export const OUTCOME_CHECK_TOOL = "request_outcome_check";

/** The fixed description `tools/list` shows for the signal tool. */
export const OUTCOME_CHECK_DESCRIPTION =
  "Ask the user to check whether this job's outcome has been reached. Only the user can run the check and complete the lease; this call only tells them you asked.";

/** The sentinel `resource` on the signal's call receipt (the `user_confirm` / `UNRESOLVED_RESOURCE` convention). */
const OUTCOME_CHECK_RESOURCE = "outcome_check";

const OUTCOME_CHECK_SUMMARY = "agent requested an outcome check";
const OUTCOME_CHECK_DENIED_SUMMARY = "agent requested an outcome check (denied: lease_not_active)";

/** The only answer the agent ever gets: fully static, no lease id, no echo of the call. */
const OUTCOME_CHECK_ANSWER =
  "The user has been asked to run the outcome check. Only the user can complete this lease; keep working or wait.";

/**
 * The agent's `request_outcome_check` call (SPEC-11): a NOTICE, never a completion. It appends the
 * standard call receipt, tells the host and answers with fixed text. It consumes no binding, counter,
 * limit or approval (the verifier read's counter discipline), and it makes no state change of any
 * kind: the lease is returned exactly as loaded. Completion exists only behind the user-run check in
 * `@stint/runtime`; this branch has no transition call by design.
 */
async function handleOutcomeCheckSignal(deps: ProxyDeps, now: number): Promise<CallToolResult> {
  const seen = { active: false };
  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    seen.active = lease.state === "active";
    await appendCallReceipt(
      deps.receiptStore,
      [],
      {
        resource: OUTCOME_CHECK_RESOURCE,
        argsHash: hashCanonical({}),
        redactedSummary: seen.active ? OUTCOME_CHECK_SUMMARY : OUTCOME_CHECK_DENIED_SUMMARY,
        outcome: seen.active ? "allowed" : "denied",
      },
      now,
    );
    return lease;
  });
  if (!seen.active) return denyResult("lease_not_active");
  try {
    await deps.notify?.({ type: "outcome_check_requested", leaseId: deps.leaseId, at: now });
  } catch {
    // Best effort: a host that cannot show the notice never changes the call's result.
  }
  return textResult(OUTCOME_CHECK_ANSWER, false);
}

/** How often the lock-free lease-end watcher polls the lease store while an approval is pending, in milliseconds (D-20). */
const DEFAULT_APPROVAL_WATCH_MS = 1000;

/** The state `handleCall` threads through a call's one or two transactions so exactly one receipt and one telemetry event describe it. */
interface CallState {
  outcome: "allowed" | "denied";
  detail: string | undefined;
  /** True once the held approval's commitment verified: the human's yes still stands. */
  approved: boolean;
  /** True when the call was approved and then denied by the re-check (D-21). */
  deniedAfterApproval: boolean;
  voidReason: ApprovalVoidReason | undefined;
}

/** The call parked between the two transactions while a human decides (PRXY-10, D-18). */
interface DeferredApproval {
  readonly ctx: CallContext;
  readonly requirement: ApprovalRequirement;
}

/** Maps a post-approval policy denial to the fixed reason the user is shown (D-21). */
function voidReasonForPolicy(reason: string): ApprovalVoidReason {
  if (reason === "expired") return "expired_after_approval";
  if (reason === "lease_not_active") return "lease_ended_after_approval";
  if (reason === "over_max_actions" || reason === "over_spend" || reason === "over_actions_per_hour") {
    return "limit_reached_after_approval";
  }
  return "approval_drifted";
}

/**
 * The one dispatch point every `tools/call` (allowed, denied, or naming a
 * hidden/unbound tool directly) flows through. Resolves args
 * (`params.arguments ?? {}`), resolves the effective binding, then runs
 * authorize -> execute -> receipt inside a per-lease transaction so the
 * receipt append happens in the same serialized step as the counters it
 * mutates (D-13). The receipt is appended in a `finally` block so a thrown
 * `execute` never skips it.
 *
 * A call that needs a human approval does NOT hold the lease's serialization
 * while it waits (PRXY-10, D-18). The first transaction evaluates policy and,
 * for `require_approval`, returns the lease unchanged with no receipt. The
 * wait then happens with no lock held, watched by a lock-free poll that
 * cancels it if the lease ends (D-20). A second, short transaction re-enters
 * the lease and evaluates the facts again with a fresh clock reading before
 * anything runs: the approval commitment, expiry, lease state, policy and
 * limits (PRXY-09, D-19). Nothing is reserved during the wait, so no limit is
 * ever exceeded. Exactly one receipt is appended per call, in the transaction
 * that decides it, so chain order is decision order, not arrival order. A
 * call approved and then denied by the re-check says so in its receipt and on
 * the user's terminal; the agent only ever gets the plain denial reason (D-21).
 */
export async function handleCall(
  deps: ProxyDeps,
  params: { readonly name: string; readonly arguments?: Readonly<Record<string, unknown>> },
  now: number,
): Promise<CallToolResult> {
  // The fixed signal tool is answered before any binding lookup (SPEC-11): it is a notice, not a call.
  if (params.name === OUTCOME_CHECK_TOOL) return await handleOutcomeCheckSignal(deps, now);
  const resolvedArgs: Record<string, unknown> = { ...(params.arguments ?? {}) };
  const binding = resolveEffectiveBinding(deps.bindings, deps.grantedScopes, deps.grantedResources, params.name);
  // Pre-authorization spend extraction (D-07): a pay tool's runtime-owned
  // catalog descriptor is the ONLY amount source -- never the manifest, never
  // anything the agent supplies beyond the arg value itself. A read/write/send
  // tool (no `payAmount` descriptor) always yields `undefined` here.
  const catalogEntry = resolveCatalogEntry(deps.catalog, params.name);
  const spendMinor = catalogEntry !== undefined ? extractSpendMinor(catalogEntry, resolvedArgs) : undefined;
  const call: PolicyCall = { tool: params.name, spendMinor };

  const box: { result?: CallToolResult; deferred?: DeferredApproval } = {};
  const st: CallState = {
    outcome: "denied",
    detail: undefined,
    approved: false,
    deniedAfterApproval: false,
    voidReason: undefined,
  };

  /** Appends the call's single receipt in the transaction that decided it. */
  const appendReceipt = async (at: number): Promise<void> => {
    const chain = await deps.receiptStore.load("verified");
    const payload = buildCallPayload(
      binding,
      resolvedArgs,
      st.outcome,
      st.detail,
      st.deniedAfterApproval ? { afterApproval: true } : undefined,
    );
    await appendCallReceipt(deps.receiptStore, chain, payload, at);
  };

  /** Caps, execute and commit. Errors are classified by `handleExecuteError` in the caller's catch. */
  const authorizeExecuteCommit = async (lease: Lease, ctx: CallContext, at: number): Promise<Lease> => {
    const capCheck = deps.enforceCaps.authorize(lease, call, deps.limits, at);
    if (!capCheck.ok) {
      st.detail = capCheck.reason ?? "cap_exceeded";
      if (st.approved) {
        st.deniedAfterApproval = true;
        st.voidReason = "limit_reached_after_approval";
      }
      box.result = denyResult(st.detail);
      return lease;
    }

    const execResult = await deps.execute.execute(ctx, at);
    st.outcome = "allowed";
    box.result = allowResult(execResult);
    return deps.enforceCaps.commit(lease, call, at);
  };

  /**
   * D-09/PRXY-07: a failed outbound refresh classifies as provider_revoked or
   * transient_error (04-05's vault). Only the former ever advances lease
   * state -- a single transient blip never revokes (module docstring above).
   */
  const handleExecuteError = async (err: unknown, lease: Lease, at: number): Promise<Lease> => {
    st.outcome = "denied";
    if (err instanceof CredentialRefreshError) {
      if (isProviderRevocation(err.kind)) {
        st.detail = "provider_revoked";
        box.result = denyResult(st.detail);
        let nextLease = lease;
        const revocation = applyProviderRevocation(lease, at);
        if (revocation.ok) {
          nextLease = revocation.value.lease;
          // grant_revoked then begin_teardown, in order (D-18) -- appended
          // inside this SAME per-lease transaction so the ending is
          // receipted atomically with the triggering call's denial.
          for (const transition of revocation.value.transitions) {
            await appendTransitionReceipt(deps.receiptStore, transition, at);
          }
        }
        return nextLease;
      }
      st.detail = "transient_error";
      box.result = denyResult(st.detail);
      return lease;
    }
    st.detail = "execute_failed";
    // Deliberately generic -- never echoes the underlying error's message,
    // which could carry args/credential material from a connector (D-13).
    box.result = errorResult();
    return lease;
  };

  // First transaction: decide, and either finish the call or park it for approval.
  let finalLease = await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    try {
      const decision = evaluatePolicy(lease, call, binding, deps.limits, deps.approvals, now);

      if (decision.decision === "deny") {
        st.detail = decision.reason;
        box.result = denyResult(st.detail);
        return lease;
      }

      // Invariant: `evaluatePolicy` only reaches `require_approval`/`allow`
      // when its own Step 1 resolved a real binding.
      if (binding === undefined) {
        throw new Error(
          "@stint/proxy: invariant violated -- evaluatePolicy returned a non-deny decision with no binding.",
        );
      }
      const ctx: CallContext = {
        leaseId: deps.leaseId,
        tool: params.name,
        resolvedArgs,
        binding,
        leaseVersion: lease.version,
      };

      if (decision.decision === "require_approval") {
        // Park the call: nothing is reserved, no receipt is written, and the
        // lease is returned unchanged so the lock is free during the wait.
        box.deferred = { ctx, requirement: decision.requirement };
        return lease;
      }

      return await authorizeExecuteCommit(lease, ctx, now);
    } catch (err) {
      return await handleExecuteError(err, lease, now);
    } finally {
      if (box.deferred === undefined) {
        await appendReceipt(now);
      }
    }
  });

  const deferred = box.deferred;
  let decidedAt = now;
  if (deferred !== undefined) {
    // Unlocked wait, watched for the lease ending (D-20).
    const leaseEnded = new AbortController();
    let polling = false;
    const watcher = setInterval(() => {
      if (polling || leaseEnded.signal.aborted) return;
      polling = true;
      deps.leaseStore
        .load(deps.leaseId)
        .then((current) => {
          const ended =
            current === undefined ||
            current.state !== "active" ||
            (current.expiresAt > 0 && deps.clock() >= current.expiresAt);
          if (ended && !leaseEnded.signal.aborted) leaseEnded.abort(createLeaseEndedReason());
        })
        .catch(() => {
          // a failed poll is ignored; the second transaction still re-checks everything
        })
        .finally(() => {
          polling = false;
        });
    }, deps.approvalWatchMs ?? DEFAULT_APPROVAL_WATCH_MS);

    let approval: ApprovalDecision;
    try {
      approval = await deps.approve.requestApproval(deferred.ctx, deferred.requirement, now, {
        signal: leaseEnded.signal,
      });
    } finally {
      clearInterval(watcher);
    }

    // Second transaction: a fresh clock, then re-check everything before executing.
    const nowB = Math.max(now, deps.clock());
    decidedAt = nowB;
    const commitment = { verified: false };
    try {
      finalLease = await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
        try {
          // (1) The human, the clock or the lease said no.
          if (approval.decision === "deny") {
            st.detail = approval.reason ?? "approval_denied";
            box.result = denyResult(st.detail);
            return lease;
          }

          // (2) Recompute-and-match (D-11, PRXY-05) against THIS transaction's
          // lease: a hot-swapped binding, changed args or a lease-version bump
          // during the wait is `approval_drifted`. `verifyCommitment` consumes
          // the pending entry.
          const currentBinding = resolveEffectiveBinding(
            deps.bindings,
            deps.grantedScopes,
            deps.grantedResources,
            params.name,
          );
          const currentHash =
            currentBinding !== undefined ? computeApprovalHash(resolvedArgs, currentBinding, lease.version) : undefined;
          let isCommitmentValid = false;
          if (approval.approvalId !== undefined && currentHash !== undefined) {
            commitment.verified = true;
            isCommitmentValid = deps.approve.verifyCommitment(approval.approvalId, currentHash);
          }
          st.approved = isCommitmentValid;
          if (!isCommitmentValid || currentBinding === undefined) {
            st.detail = "approval_drifted";
            st.deniedAfterApproval = true;
            st.voidReason = "approval_drifted";
            box.result = denyResult(st.detail);
            return lease;
          }

          // (3) Expiry, lease state, policy and limits again, with the fresh clock (D-19).
          const policy = evaluatePolicy(lease, call, currentBinding, deps.limits, deps.approvals, nowB);
          if (policy.decision === "deny") {
            st.detail = policy.reason;
            st.deniedAfterApproval = true;
            st.voidReason = voidReasonForPolicy(policy.reason);
            box.result = denyResult(st.detail);
            return lease;
          }

          // (4)-(5) Caps, execute, commit.
          const ctx: CallContext = { ...deferred.ctx, binding: currentBinding, leaseVersion: lease.version };
          return await authorizeExecuteCommit(lease, ctx, nowB);
        } catch (err) {
          return await handleExecuteError(err, lease, nowB);
        } finally {
          await appendReceipt(nowB);
        }
      });
    } finally {
      // The commitment never reaches verifyCommitment when the transaction
      // could not open, threw early, or the binding vanished: release it.
      if (!commitment.verified && approval.decision === "approve" && approval.approvalId !== undefined) {
        deps.approve.release?.(approval.approvalId);
      }
    }

    if (st.deniedAfterApproval && st.voidReason !== undefined && deps.approve.reportVoided !== undefined) {
      try {
        await deps.approve.reportVoided(deferred.ctx, st.voidReason, nowB);
      } catch {
        // telling the user is best effort and never changes the call's result
      }
    }
  }

  const result = box.result;
  if (result === undefined) {
    // unreachable: every path above sets `result` before returning from the mutator.
    throw new Error("@stint/proxy: handleCall produced no result.");
  }

  safeEmit(deps.telemetry, {
    name: "call.decided",
    leaseId: deps.leaseId,
    tool: binding?.tool ?? "unknown",
    outcome: st.outcome,
    ...(st.detail !== undefined ? { reason: st.detail } : {}),
  });

  // 05-03 (TEAR-01, D-18, D-30): the triggering call's own transaction has
  // fully committed above -- this opens a SEPARATE, later per-lease
  // transaction, never a nested one. Opt-in via `deps.teardownSteps` so
  // callers that don't wire it (every pre-05-03 `ProxyDeps`) keep working
  // unchanged.
  if (deps.teardownSteps !== undefined && TEARDOWN_TRIGGER_STATES.has(finalLease.state)) {
    try {
      await runTeardown(
        {
          leaseStore: deps.leaseStore,
          receiptStore: deps.receiptStore,
          leaseId: deps.leaseId,
          steps: deps.teardownSteps,
          ...(deps.teardownFence === undefined ? {} : { fence: deps.teardownFence }),
        },
        decidedAt,
      );
    } catch (error) {
      // Another driver (the supervisor, a user command) owns this teardown
      // pass (D-09). The call's own result is already decided; it is returned
      // unchanged. Every other error propagates as before.
      if (!(error instanceof TeardownFencedError)) throw error;
    }
  }

  return result;
}
