/**
 * `runResourceQueryVerification` -- the `resource_query` outcome-verification
 * trigger (LIFE-06, D-02, D-03, D-06, D-07).
 *
 * The agent may only SIGNAL "check done"; this module IS the runtime-run
 * evaluation that signal triggers (D-03) -- there is no code path anywhere in
 * `@stint/proxy` where an agent-supplied "done" claim itself transitions a
 * lease. `runResourceQueryVerification` performs a verifier-actor SYNTHETIC
 * read against the verifier resource's runtime-owned binding, reusing the
 * EXACT `vault.resolveAccessToken` + `OutboundConnector` + scrub path
 * `vault/execute-stage.ts`'s `createVaultExecuteStage` uses for a real call
 * (D-02) -- never a second credential seam, never registered in
 * `tools/list`, never touching the action/spend limit counters
 * (`actionCount`/`spentMinor`/`actionTimestamps`). The read result is
 * normalized via the binding's runtime-owned `rowAdapter` (D-06,
 * `bindings.ts`) and evaluated by `@stint/spec`'s pure `evaluatePredicate`
 * against the closed `PredicateAst` (05-02).
 *
 * Outcome semantics (D-03): predicate `true` -> `verifierEvents.outcomeVerified()`
 * (actor `verifier`) -> `completed`, immediately auto-chained into
 * `begin_teardown` via the shared `chainTeardownIfEnded` helper (D-18) and,
 * when `deps.teardownSteps` is supplied, the full teardown orchestrator
 * (mirrors `dispatch.ts`'s post-transaction `runTeardown` call, D-30: never
 * nested); predicate `false` -> a no-op (lease stays `active`, one negative
 * verification receipt, no state change); a read/evaluate error -> one
 * `outcome=error` verification receipt, the error recorded toward the
 * LIFE-07 threshold counter (`denialErrorTimestamps`), the lease stays
 * `active` and never completes (see 05-07-PLAN.md's `flagged_assumptions`:
 * the counter-reaching-threshold -> `failed` DISPATCH itself remains the
 * pre-existing, not-yet-wired Phase 6 gap -- this function only records
 * toward it, it does not invent that dispatch).
 *
 * Every verification attempt appends EXACTLY ONE verified-chain receipt
 * (D-07), reusing the existing `CallPayload` shape (`resource` + `argsHash`
 * + `redactedSummary` + `outcome: allowed | denied`) -- the closest-fit
 * existing receipt entry type; this plan adds no new schema entry.
 * `resource` carries the verifier resource id; `redactedSummary` names the
 * actor (`verifier`), the closed outcome (`true`/`false`/`error`), and a
 * stable reason string; `outcome` maps `true -> allowed`, `false`/`error ->
 * denied`. NEVER a raw row, field value, or the query result (D-07) --
 * `argsHash` is always `hashCanonical({})` (the synthetic read carries no
 * agent-supplied args), never a hash of the read result.
 */

import { appendEntry, reduce, verifierEvents } from "@stint/core";
import type {
  CallPayload,
  ConnectorBinding,
  Lease,
  LeaseStore,
  ReceiptStore,
  Result,
  TransitionRecord,
} from "@stint/core";
import { evaluatePredicate, hashCanonical } from "@stint/spec";
import type { PredicateAst } from "@stint/spec";

import { runInLeaseTransaction } from "../concurrency/lease-serializer.js";
import type { CredentialVault } from "../vault/credential-vault.js";
import { scrubCredential, scrubError } from "../vault/scrub.js";
import type { OutboundConnector } from "../connectors/outbound-connector.js";
import { chainTeardownIfEnded } from "../teardown/auto-chain.js";
import { appendTransitionReceipt, runTeardown } from "../teardown/orchestrate.js";
import type { TeardownStep } from "../teardown/steps.js";

/**
 * The closed outcome of one `resource_query` verification attempt (D-03,
 * D-07). `"true"`/`"false"` are the predicate's own boolean result; `"error"`
 * is a read or evaluation failure -- never surfaced as a predicate result.
 */
export type ResourceQueryOutcome = "true" | "false" | "error";

/**
 * The minimal deps needed to drive a verified `true`/`confirm` outcome to
 * `completed` -> auto-chained `begin_teardown` (+ optional full teardown
 * run) -- shared by `resource-query.ts` and `user-confirm.ts` (D-18) so
 * every verifier type funnels through the EXACT same completion path, never
 * a duplicated ending-state check.
 */
export interface VerifierCompletionDeps {
  readonly leaseStore: LeaseStore;
  readonly receiptStore: ReceiptStore;
  readonly leaseId: string;
  /**
   * OPTIONAL (mirrors `ProxyDeps.teardownSteps`/`TeardownDeps.steps` being
   * optional elsewhere): when supplied, a `true`/`confirm` outcome's
   * auto-chained `begin_teardown` is immediately followed by a full
   * `runTeardown` pass in its own, separate per-lease transaction (D-30).
   */
  readonly teardownSteps?: readonly TeardownStep[];
}

/**
 * Every construction-time dependency `runResourceQueryVerification` needs.
 * `binding` is the ALREADY-RESOLVED, runtime-owned `ConnectorBinding` for the
 * manifest's `job.verifier.resource` (D-02, D-06) -- this module never
 * resolves a binding itself, mirroring `vault/execute-stage.ts`'s
 * `CallContext.binding` convention. `ast` is the already-parsed
 * `PredicateAst` (05-02's `parsePredicate`, validated at manifest time,
 * D-04) -- this module never re-parses the predicate string.
 */
export interface ResourceQueryDeps extends VerifierCompletionDeps {
  readonly vault: CredentialVault;
  readonly connector: OutboundConnector;
  readonly binding: ConnectorBinding;
  readonly ast: PredicateAst;
}

/** Builds the secretless verification receipt's `redactedSummary` (D-07) -- never a raw row/value/query result, only the closed outcome + a stable reason. */
function verificationRedactedSummary(
  kind: "resource_query" | "user_confirm",
  outcome: string,
  reason: string,
): string {
  return `${kind} verification (actor=verifier): outcome=${outcome}, reason=${reason}`;
}

/**
 * Appends ONE verified-chain verification receipt (D-07), reusing the
 * `CallPayload` shape. `argsHash` is always `hashCanonical({})` -- a
 * verification attempt carries no agent-supplied args, never a hash of the
 * read result (never raw rows/values/query result reach a receipt).
 */
export async function appendVerificationReceipt(
  receiptStore: ReceiptStore,
  kind: "resource_query" | "user_confirm",
  resource: string,
  outcome: "true" | "false" | "error",
  reason: string,
  now: number,
): Promise<void> {
  const payload: CallPayload = {
    resource,
    argsHash: hashCanonical({}),
    redactedSummary: verificationRedactedSummary(kind, outcome, reason),
    outcome: outcome === "true" ? "allowed" : "denied",
  };
  const chain = await receiptStore.load("verified");
  const entry = appendEntry(chain, { chain: "verified", type: "call", payload }, now);
  await receiptStore.append("verified", entry);
}

/**
 * Applies `apply` (a `reduce()`-shaped transition) to the current lease under
 * the per-lease serializer, appends the resulting `TransitionRecord` as a
 * verified-chain receipt, and returns the next lease -- mirrors
 * `teardown/orchestrate.ts`'s private `applyTransition` exactly. Throws only
 * on an invariant violation (the transition was illegal for the CURRENT
 * lease state), never for an expected business outcome.
 */
async function applyVerifiedTransition(
  leaseStore: LeaseStore,
  receiptStore: ReceiptStore,
  leaseId: string,
  now: number,
  apply: (lease: Lease) => Result<{ lease: Lease; transition: TransitionRecord }>,
): Promise<Lease> {
  let record: TransitionRecord | undefined;
  const nextLease = await runInLeaseTransaction(leaseStore, leaseId, (lease) => {
    const result = apply(lease);
    if (!result.ok) {
      throw new Error(`@stint/proxy: verification transition rejected: ${result.errors[0]?.code ?? "unknown"}.`);
    }
    record = result.value.transition;
    return result.value.lease;
  });
  if (record !== undefined) {
    await appendTransitionReceipt(receiptStore, record, now);
  }
  return nextLease;
}

/**
 * Records `now` toward the LIFE-07 error-threshold counter
 * (`denialErrorTimestamps`) -- data-only, per 05-07-PLAN.md's
 * `flagged_assumptions`: the actual `checkErrorThreshold` -> `failed`
 * dispatch is a separate, not-yet-wired gap this function does not invent.
 */
async function recordVerificationErrorTowardThreshold(
  leaseStore: LeaseStore,
  leaseId: string,
  now: number,
): Promise<void> {
  await runInLeaseTransaction(leaseStore, leaseId, (lease) => ({
    ...lease,
    counters: { ...lease.counters, denialErrorTimestamps: [...lease.counters.denialErrorTimestamps, now] },
  }));
}

/** Drives a `true`/`confirm`-outcome verification to `completed` -> auto-chained `begin_teardown`, then (if configured) the full teardown orchestrator. Shared by `resource-query.ts` and `user-confirm.ts` (D-18). */
export async function completeViaVerifier(deps: VerifierCompletionDeps, now: number): Promise<void> {
  await applyVerifiedTransition(deps.leaseStore, deps.receiptStore, deps.leaseId, now, (lease) => {
    const verified = reduce(lease, verifierEvents.outcomeVerified(), now);
    if (!verified.ok) return verified;
    return chainTeardownIfEnded(verified.value.lease, now);
  });

  if (deps.teardownSteps !== undefined) {
    await runTeardown(
      {
        leaseStore: deps.leaseStore,
        receiptStore: deps.receiptStore,
        leaseId: deps.leaseId,
        steps: deps.teardownSteps,
      },
      now,
    );
  }
}

/**
 * Runs one `resource_query` verification attempt (LIFE-06): the runtime-run
 * evaluation an agent's "check done" signal triggers -- see module docstring
 * for the full outcome semantics (D-03) and receipt discipline (D-07).
 * Returns the closed outcome; never throws for an expected business result
 * (a read failure or predicate mismatch is always the `"error"`/`"false"`
 * outcome, never a rejected promise).
 */
export async function runResourceQueryVerification(
  deps: ResourceQueryDeps,
  now: number,
): Promise<ResourceQueryOutcome> {
  let outcome: ResourceQueryOutcome;
  let reason: string;

  try {
    // The ONLY token read path (D-02) -- the exact same call
    // `vault/execute-stage.ts`'s `createVaultExecuteStage` makes for a real
    // tool call, never a second credential seam.
    const accessToken = await deps.vault.resolveAccessToken(deps.leaseId, deps.binding.resource, now);

    let execResult: { readonly status: number; readonly body: unknown };
    try {
      // A verifier-actor SYNTHETIC read: no agent-supplied args, never
      // registered in tools/list, never touching action/spend counters.
      const rawResult = await deps.connector.execute(deps.binding, {}, { accessToken });
      execResult = scrubCredential(rawResult, [accessToken]);
    } catch (err) {
      throw scrubError(err, [accessToken]);
    }

    if (deps.binding.rowAdapter === undefined) {
      throw new Error(
        `@stint/proxy: verifier binding for resource "${deps.binding.resource}" has no rowAdapter configured.`,
      );
    }
    const { rows } = deps.binding.rowAdapter(execResult);
    const matched = evaluatePredicate(deps.ast, rows);
    outcome = matched ? "true" : "false";
    reason = matched ? "predicate_true" : "predicate_false";
  } catch {
    // Every failure mode (token refresh failure, connector error, missing
    // rowAdapter, or an evaluate-time throw) collapses to the SAME "error"
    // outcome -- never a raw error message reaches a receipt (D-07).
    outcome = "error";
    reason = "verification_read_error";
  }

  if (outcome === "true") {
    await completeViaVerifier(deps, now);
  } else if (outcome === "error") {
    await recordVerificationErrorTowardThreshold(deps.leaseStore, deps.leaseId, now);
  }

  await appendVerificationReceipt(deps.receiptStore, "resource_query", deps.binding.resource, outcome, reason, now);

  return outcome;
}
