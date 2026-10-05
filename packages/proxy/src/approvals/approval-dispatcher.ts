/**
 * `createApprovalDispatcher` -- the real out-of-band `ApprovalStage`
 * (PRXY-05, D-11): fills the seam 04-02 defined in `dispatch.ts`. Every
 * `send`/`pay`/`irreversible` call `evaluatePolicy` classifies
 * `require_approval` is held here, out-of-band through the `HostAdapter`,
 * NEVER via MCP elicitation through the agent's own client -- the ONLY
 * sanctioned way to call `adapter.requestApproval` is `@stint/core`'s
 * `awaitApprovalDecision` (deny-by-default on abort/throw/never-resolve,
 * Phase 2 D-17); this module arms the actual `AbortController` deadline
 * from `manifest.approvals.timeout_seconds` and never re-derives the
 * deny-by-default race logic itself.
 *
 * `computeApprovalHash` is the ONE content-addressed commitment (D-11,
 * confirmed at the Task 1 checkpoint of 04-04-PLAN.md, `proposed-tuple`):
 * `hashCanonical({ args, tool, provenance, leaseVersion })` over the
 * `@stint/spec` canonical serializer -- the SAME serializer receipts use,
 * never `JSON.stringify`, never a second serializer. The commitment is
 * computed once when the call is held (from the `CallContext` handed to
 * `requestApproval`, BEFORE the out-of-band wait) and stored in a
 * module-private `Map` keyed by an opaque `approvalId`; `verifyCommitment`
 * is the ONLY way to read it back, and it consumes the entry (deleted after
 * one check) so a single commitment can never be checked twice or reused
 * across a different call. `dispatch.ts` recomputes the hash from the
 * CURRENT resolved args + binding identity + lease version at execution
 * time and calls `verifyCommitment` before proceeding -- any drift (arg
 * change, binding hot-swap, lease-version advance) denies the reused
 * approval as a new request (all three D-11 drift vectors).
 *
 * No raw call argument is ever placed on the `ApprovalRequest`, the pending
 * record, or any returned value (D-18) -- only the commitment hash and a
 * binding-redacted summary reach the `HostAdapter` or the pending-approval
 * store.
 */

import { awaitApprovalDecision } from "@stint/core";
import type {
  ApprovalDecision as HostApprovalDecision,
  ApprovalRequest,
  ApprovalRequirement,
  ApprovalVoidReason,
  HostAdapter,
} from "@stint/core";
import { hashCanonical } from "@stint/spec";
import type { ContentHash } from "@stint/spec";

import type { ApprovalDecision, ApprovalRequestOptions, ApprovalStage, CallContext } from "../dispatch.js";

/**
 * A held call's stored commitment (D-11) -- carries only the opaque id and
 * the hash, never raw args. `requestedAt` (the injected `clock()` value at
 * hold time) is metadata only; it plays no role in `verifyCommitment`'s
 * match check.
 */
export interface PendingApproval {
  readonly approvalId: string;
  readonly commitmentHash: ContentHash;
  readonly requestedAt: number;
}

/**
 * Module-private pending-approval store (Phase 4 scope: in-process only --
 * restart-survival of a mid-flight approval is out of scope and flagged,
 * not silently assumed; see 04-04-PLAN.md's `flagged_assumptions` and
 * RESEARCH.md Open Question 2. Phase 6 persists it). Shared across every
 * `createApprovalDispatcher` instance in this process; `approvalId`s are
 * drawn from a single monotonically increasing sequence so two dispatcher
 * instances (e.g. one per lease) can never mint a colliding id.
 */
const pendingApprovals = new Map<string, PendingApproval>();
let approvalSequence = 0;

/** The most approvals one dispatcher lets wait at once; past it a request is denied `approval_queue_full` without asking the adapter (A13, T-08-49). */
export const DEFAULT_MAX_PENDING_APPROVALS = 20;

/**
 * The confirmed D-11 commitment-hash tuple (04-04-PLAN.md Task 1 checkpoint,
 * `proposed-tuple`, resolving D-11's "provenance/version" ambiguity as
 * `binding.provenance` + the lease's own `version`):
 * `canonicalize({ args, tool, provenance, leaseVersion })` via
 * `@stint/spec`'s `hashCanonical` -- pure, equal for equal (args, tool,
 * provenance, version), and any single-field drift changes the hash.
 */
export function computeApprovalHash(
  resolvedArgs: Readonly<Record<string, unknown>>,
  binding: { readonly tool: string; readonly provenance: string },
  leaseVersion: number,
): ContentHash {
  return hashCanonical({
    args: resolvedArgs,
    tool: binding.tool,
    provenance: binding.provenance,
    leaseVersion,
  });
}

/** Binding-redacted approval summary (D-18) -- built ONLY from the binding's tool/resource and the trigger; never from `ctx.resolvedArgs`. */
function redactedSummary(ctx: CallContext, requirement: ApprovalRequirement): string {
  return `call to "${ctx.binding.tool}" on resource "${ctx.binding.resource}" requires approval (${requirement.trigger})`;
}

/**
 * Constructs the real `ApprovalStage` (PRXY-05). `timeoutSeconds` sources
 * the real deadline -- callers pass `manifest.approvals.timeout_seconds`,
 * never a hardcoded constant. `clock` stamps the pending record's
 * `requestedAt` only; the actual deadline is a real `setTimeout`, not a
 * pure comparison against an injected `now` -- an interactive out-of-band
 * wait is exactly the one place in this codebase a real timer is correct
 * (unlike `evaluatePolicy`'s per-call expiry, which stays timerless).
 *
 * The timer is armed when the approval is requested, so a request that waits
 * behind others in a host's display queue still times out on schedule (D-18).
 * The signal handed to the adapter merges that timeout with the optional
 * lease-ended signal `handleCall` passes (D-20). At most `opts.maxPending`
 * (default 20) requests may wait at once per dispatcher; the next is denied
 * `approval_queue_full` without reaching the adapter (A13).
 */
export function createApprovalDispatcher(
  adapter: HostAdapter,
  timeoutSeconds: number,
  clock: () => number,
  opts?: { readonly maxPending?: number },
): ApprovalStage {
  const maxPending = opts?.maxPending ?? DEFAULT_MAX_PENDING_APPROVALS;
  let inFlight = 0;

  return {
    async requestApproval(
      ctx: CallContext,
      requirement: ApprovalRequirement,
      _now: number,
      requestOpts?: ApprovalRequestOptions,
    ): Promise<ApprovalDecision> {
      if (inFlight >= maxPending) {
        return { decision: "deny", reason: "approval_queue_full" };
      }
      inFlight += 1;

      approvalSequence += 1;
      const approvalId = `approval-${String(approvalSequence)}`;
      const commitmentHash = computeApprovalHash(ctx.resolvedArgs, ctx.binding, ctx.leaseVersion);
      pendingApprovals.set(approvalId, { approvalId, commitmentHash, requestedAt: clock() });

      const request: ApprovalRequest = {
        approvalId,
        summary: redactedSummary(ctx, requirement),
        binding: ctx.binding,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutSeconds * 1000);
      const signal =
        requestOpts?.signal !== undefined
          ? AbortSignal.any([controller.signal, requestOpts.signal])
          : controller.signal;

      let decision: HostApprovalDecision;
      try {
        // The ONLY sanctioned way to call `adapter.requestApproval` --
        // races the adapter against `signal`, resolving `{ decision:
        // 'deny', reason: 'timeout' }` on abort, adapter rejection/throw, or
        // a late resolution that loses the race, and `lease_ended` when the
        // lease-ended signal aborted it (Phase 2 D-17, D-20). A slow,
        // throwing, or hostile adapter can never turn a held call into an
        // allow.
        decision = await awaitApprovalDecision(adapter, request, signal);
      } finally {
        clearTimeout(timer);
        inFlight -= 1;
      }

      if (decision.decision === "approve") {
        return { decision: "approve", approvalId };
      }

      pendingApprovals.delete(approvalId);
      return { decision: "deny", reason: decision.reason };
    },

    /** Drops a commitment whose approval will never be verified (the post-approval transaction failed first). */
    release(approvalId: string): void {
      pendingApprovals.delete(approvalId);
    },

    /**
     * Tells the user an approval they gave did not take effect (D-21), through
     * the existing `notify` method. Best effort: every failure is swallowed so
     * it can never change a call's result.
     */
    async reportVoided(ctx: CallContext, reason: ApprovalVoidReason, now: number): Promise<void> {
      try {
        await adapter.notify({ type: "approval_void", leaseId: ctx.leaseId, at: now, reason });
      } catch {
        // a failed notice must not alter the call's result
      }
    },

    /**
     * The ONLY way to read a stored commitment back. Consumes the entry
     * (deleted whether it matches or not) so a single commitment can never
     * be checked twice -- an unknown/already-consumed `approvalId` always
     * returns `false` (deny by default), never throws.
     */
    verifyCommitment(approvalId: string, currentHash: ContentHash): boolean {
      const pending = pendingApprovals.get(approvalId);
      pendingApprovals.delete(approvalId);
      if (pending === undefined) return false;
      return pending.commitmentHash === currentHash;
    },
  };
}
