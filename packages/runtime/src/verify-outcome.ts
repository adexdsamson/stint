/**
 * `runOutcomeCheck`: the one evaluation of a lease's verifier (CLI-03).
 *
 * A live run's `verifyOutcome()` and the standalone `verify-outcome` command
 * both end up in `evaluateVerifier`, so there is exactly one place in the
 * repository where a verifier is evaluated and one path by which a lease is
 * completed through it:
 *
 *  - `resource_query`: a verifier-actor read through the vault and the composed
 *    connector, normalized by the binding's row adapter and judged by the
 *    manifest's predicate (`runResourceQueryVerification`).
 *  - `user_confirm`: the question goes to the user through the HostAdapter, out
 *    of band, never through the agent's own channel (`runUserConfirmVerification`).
 *  - `none`: nothing to evaluate. A usage error pointing at `stint revoke`.
 *
 * Both evaluators funnel a pass through `completeViaVerifier` (receipt,
 * `outcome_verified`, `begin_teardown`, fenced teardown), and a fail changes
 * nothing but a receipt. The `user_confirm` wait holds no lease serialization:
 * the prompt resolves before any transition helper runs.
 */

import { resumeLease } from "@stint/core";
import type { BindingSet, ConnectorBinding, HostAdapter, Lease, LeaseStore, ReceiptStore } from "@stint/core";
import {
  TRANSACTION_VERDICTS,
  appendTransitionReceipt,
  createCredentialVault,
  runResourceQueryVerification,
  runUserConfirmVerification,
} from "@stint/proxy";
import type {
  CredentialVault,
  FetchLike,
  OutboundConnector,
  ResourceQueryOutcome,
  TeardownFenceConfig,
  TeardownStep,
  TransactionVerdict,
  UserConfirmOutcome,
} from "@stint/proxy";
import { parsePredicate } from "@stint/spec";
import type { Manifest } from "@stint/spec";

import { RuntimeError } from "./errors.js";
import { isLoopbackHttp } from "./loopback.js";
import { createRuntimeOutboundConnector } from "./outbound.js";
import type { RuntimePorts } from "./ports.js";
import type { RunProfile } from "./profile.js";
import { resolveTeardown } from "./resolve-teardown.js";

export interface OutcomeCheckOptions {
  readonly leaseId: string;
  /**
   * The non-secret run profile (bindings, catalog, OAuth client). A `resource_query` verifier needs
   * it for the read binding; a `user_confirm` verifier needs none.
   */
  readonly profile?: RunProfile | undefined;
  /** Renders the `user_confirm` question. Never reached for a `resource_query` verifier. */
  readonly adapter: HostAdapter;
  /** The caller-armed deadline for the `user_confirm` prompt; the caller disposes its own timer. */
  readonly signal: AbortSignal;
  /** Downstream fetch override (tests); the ports' fetch, then the global `fetch`, otherwise. */
  readonly outboundFetch?: FetchLike | undefined;
  /** Lets a host (or a test) wrap the five default teardown steps, as `resolveTeardown` does. */
  readonly decorateTeardownSteps?: ((steps: readonly TeardownStep[]) => readonly TeardownStep[]) | undefined;
}

/**
 * What one check found. `verdict` is the closed `TransactionVerdict` enum the verify connector
 * computed, present only when a read produced a verdict row; it carries no reference, amount or
 * upstream text.
 */
export type OutcomeCheckResult =
  | {
      readonly kind: "resource_query";
      readonly outcome: ResourceQueryOutcome;
      readonly verdict?: TransactionVerdict;
      readonly lease: Lease;
    }
  | { readonly kind: "user_confirm"; readonly outcome: UserConfirmOutcome; readonly lease: Lease };

/** The pieces a `resource_query` read needs, assembled by the caller that owns the vault and the connector. */
export interface VerifierRead {
  readonly bindings: BindingSet;
  readonly vault: CredentialVault;
  readonly connector: OutboundConnector;
}

/** Everything `evaluateVerifier` needs; both `runOutcomeCheck` and a live run assemble it. */
export interface VerifierEvaluation {
  readonly verifier: Manifest["job"]["verifier"];
  readonly leaseStore: LeaseStore;
  readonly receiptStore: ReceiptStore;
  readonly leaseId: string;
  readonly clock: () => number;
  readonly teardownSteps: readonly TeardownStep[];
  readonly teardownFence: TeardownFenceConfig;
  readonly adapter: HostAdapter;
  readonly signal: AbortSignal;
  /** Absent when the caller has no run profile; a `resource_query` verifier then refuses with a usage error. */
  readonly read?: VerifierRead | undefined;
}

const NONE_VERIFIER_MESSAGE = "The manifest has no verifier to evaluate; end the lease with stint revoke.";
const NO_PROFILE_MESSAGE =
  "A run profile is required to evaluate this verifier; pass one or end the lease with stint revoke.";
const NO_BINDING_MESSAGE =
  "The run profile has no read binding with a row adapter for the verifier; end the lease with stint revoke.";
const NOT_ACTIVE_MESSAGE = "The lease is not active, so it cannot be verified.";

async function assertActive(leaseStore: LeaseStore, leaseId: string): Promise<void> {
  const current = await leaseStore.load(leaseId);
  if (current === undefined) throw new RuntimeError("lease_not_found", "Lease not found.");
  if (current.state !== "active") throw new RuntimeError("wrong_state", NOT_ACTIVE_MESSAGE);
}

async function reload(leaseStore: LeaseStore, leaseId: string): Promise<Lease> {
  const after = await leaseStore.load(leaseId);
  if (after === undefined) throw new RuntimeError("internal", "Internal error.");
  return after;
}

/**
 * The shared evaluation. Throws a fixed-text `RuntimeError` for a usage problem (`none`, no
 * profile, no read binding) or a lease that is not active, in every case before anything is
 * appended or changed. An expected business result (a false predicate, a rejection, a read error)
 * is a returned outcome, never a throw.
 */
export async function evaluateVerifier(input: VerifierEvaluation): Promise<OutcomeCheckResult> {
  const { verifier, leaseStore, receiptStore, leaseId, clock } = input;
  const completion = {
    leaseStore,
    receiptStore,
    leaseId,
    teardownSteps: input.teardownSteps,
    teardownFence: input.teardownFence,
  };

  if (verifier.type === "none") throw new RuntimeError("usage", NONE_VERIFIER_MESSAGE);

  if (verifier.type === "user_confirm") {
    await assertActive(leaseStore, leaseId);
    // The prompt waits here with no lease transaction open; the first transition helper runs after it resolves.
    const outcome = await runUserConfirmVerification(
      { ...completion, adapter: input.adapter, prompt: verifier.prompt, signal: input.signal },
      clock(),
    );
    return { kind: "user_confirm", outcome, lease: await reload(leaseStore, leaseId) };
  }

  if (input.read === undefined) throw new RuntimeError("usage", NO_PROFILE_MESSAGE);
  const { bindings, vault, connector } = input.read;
  const ast = parsePredicate(verifier.predicate);
  // Only a READ binding may serve the synthetic verifier read (it sends no agent arguments).
  const binding: ConnectorBinding | undefined = Object.values(bindings).find(
    (b) => b.resource === verifier.resource && b.access === "read" && b.rowAdapter !== undefined,
  );
  if (!ast.ok || binding === undefined) throw new RuntimeError("usage", NO_BINDING_MESSAGE);
  await assertActive(leaseStore, leaseId);

  let verdict: TransactionVerdict | undefined;
  const outcome = await runResourceQueryVerification(
    {
      ...completion,
      vault,
      connector,
      binding,
      ast: ast.value,
      onRows: (rows) => {
        for (const row of rows) {
          const candidate = row["verdict"];
          if (typeof candidate === "string" && TRANSACTION_VERDICTS.has(candidate)) {
            verdict = candidate as TransactionVerdict;
            return;
          }
        }
      },
    },
    clock(),
  );
  const lease = await reload(leaseStore, leaseId);
  return {
    kind: "resource_query",
    outcome,
    ...(verdict === undefined ? {} : { verdict }),
    lease,
  };
}

/**
 * Evaluates the lease's verifier from the ports alone, with no live run: loads and re-verifies the
 * stored manifest, assembles the fenced teardown exactly as a cleanup would (`resolveTeardown`),
 * builds the vault and the composed connector the live run uses, and evaluates.
 *
 * Rejects with a fixed-text `RuntimeError`: `lease_not_found`, `wrong_state` (not active, or the
 * stored manifest no longer matches the bound hash, in which case the lease is failed and
 * receipted), `manifest_invalid`, or `usage` (a `none` verifier, no profile or no read binding for a
 * `resource_query` verifier).
 *
 * @experimental The runtime surface is not yet stable.
 */
export async function runOutcomeCheck(
  ports: RuntimePorts,
  options: OutcomeCheckOptions,
): Promise<OutcomeCheckResult> {
  const { leaseId, profile } = options;
  const clock = ports.clock;
  const leaseStore = ports.leases;
  const receiptStore = ports.receipts(leaseId);

  const lease = await leaseStore.load(leaseId);
  if (lease === undefined) throw new RuntimeError("lease_not_found", "Lease not found.");
  if (lease.state !== "active") throw new RuntimeError("wrong_state", NOT_ACTIVE_MESSAGE);

  const resolved = await resolveTeardown(ports, {
    leaseId,
    ...(options.decorateTeardownSteps === undefined ? {} : { decorateSteps: options.decorateTeardownSteps }),
  });
  const verified = resolved.manifest;

  // Re-verify the bound manifest hash, as a run does: a mismatch fails the lease, honestly receipted.
  const now = clock();
  const resumed = resumeLease(lease, verified, now);
  if (!resumed.ok) throw new RuntimeError("internal", "Internal error.");
  if (resumed.value.transition !== undefined) {
    await leaseStore.save(resumed.value.lease);
    await appendTransitionReceipt(receiptStore, resumed.value.transition, now);
    throw new RuntimeError(
      "wrong_state",
      "The stored manifest no longer matches the lease's bound hash; the lease was failed. Run cleanup to finish teardown.",
    );
  }

  const { steps, fence } = resolved.deps;
  if (fence === undefined) throw new RuntimeError("internal", "Internal error.");

  const read: VerifierRead | undefined =
    profile === undefined
      ? undefined
      : {
          bindings: profile.bindings,
          vault: createCredentialVault(() => profile.oauth, clock, {
            secrets: ports.secrets,
            allowInsecureRequests: isLoopbackHttp(profile.oauth.as.token_endpoint ?? ""),
          }),
          connector: createRuntimeOutboundConnector({
            fetchImpl: options.outboundFetch ?? ports.fetch ?? fetch,
            ...(profile.endpoints === undefined ? {} : { endpoints: profile.endpoints }),
            jobParameters: () => lease.jobParameters,
          }),
        };

  return await evaluateVerifier({
    verifier: verified.manifest.job.verifier,
    leaseStore,
    receiptStore,
    leaseId,
    clock,
    teardownSteps: steps,
    teardownFence: fence,
    adapter: options.adapter,
    signal: options.signal,
    read,
  });
}
