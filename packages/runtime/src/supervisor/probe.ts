/**
 * `probeLeaseGrants`: asks the provider whether an idle active lease's grants
 * are still alive and ends the lease when one was revoked (Phase 9 SUP-04,
 * D-14 to D-18).
 *
 * The whole probe runs inside ONE lease transaction. That is what keeps it
 * safe: the lease lock excludes a concurrent teardown (which would discard the
 * credential mid-probe), a second supervisor, and a `run` that holds the lock
 * while it serves a call, so nothing refreshes with a refresh token another
 * run or supervisor has just rotated. The caller hands in a vault it built just now from
 * the stores, so the vault never holds a stale copy of a rotated token
 * (research Pitfall 4).
 *
 * A live run is never probed (D-18): a reused rotating refresh token can make
 * the provider revoke the whole token family. The heartbeat is checked by the
 * caller first, because that is cheap, and again here, inside the transaction,
 * because a run may start between the two.
 *
 * Only a definitive revocation ends a lease (D-17). The first
 * `provider_revoked`, in ascending resource order, applies the provider
 * revocation and receipts both transitions (`grant_revoked` by the provider,
 * `begin_teardown` by the runtime) inside the same mutator, so the ending and
 * its trail are saved together. Everything else (a 5xx, a 429, a network
 * error, a timeout, an unexpected body) leaves the lease and its receipts
 * untouched.
 */

import type { Lease } from "@stint/core";
import { appendTransitionReceipt, applyProviderRevocation } from "@stint/proxy";
import type { CredentialVault } from "@stint/proxy";

import type { RuntimePorts } from "../ports.js";
import { isRunLive } from "./heartbeat.js";

export interface ProbeLeaseOptions {
  /** A vault built fresh from the stores for this probe; never reused across probes. */
  readonly vault: CredentialVault;
  /** The credential resources the lease is expected to hold; probed in ascending order. */
  readonly resources: readonly string[];
  /** Timeout of each token-endpoint request, in milliseconds. */
  readonly timeoutMs: number;
  /** Re-check the live-run heartbeat inside the lease transaction and skip when a run is live. */
  readonly checkLiveRun: boolean;
}

/** What one probe of a lease found. Closed union; carries no token, response body or error text. */
export type ProbeOutcome =
  | { readonly kind: "revoked"; readonly lease: Lease }
  | { readonly kind: "ok" }
  | { readonly kind: "transient"; readonly retryAfterSeconds?: number }
  | { readonly kind: "not_probeable" }
  | { readonly kind: "skipped"; readonly reason: "live_run" | "not_active" };

/**
 * Seconds to wait after `failures` consecutive transient probes:
 * `min(60 * 2^(failures-1), interval)`. Shared by the supervisor's sweep and a
 * run probing its own lease, so the two cannot drift apart.
 */
export function probeBackoffSeconds(failures: number, intervalSeconds: number): number {
  const exponent = Math.min(failures, 31) - 1;
  return Math.min(60 * 2 ** exponent, intervalSeconds);
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Probes each of `options.resources` for `leaseId` under the lease lock and
 * ends the lease on the first definitive provider revocation.
 *
 * @experimental The runtime surface is not yet stable.
 */
export async function probeLeaseGrants(
  ports: Pick<RuntimePorts, "leases" | "receipts" | "clock" | "artifacts">,
  leaseId: string,
  options: ProbeLeaseOptions,
): Promise<ProbeOutcome> {
  // A holder, not a bare `let`: the mutator below assigns it, which control-flow narrowing cannot see.
  const found: { outcome: ProbeOutcome } = { outcome: { kind: "not_probeable" } };

  await ports.leases.transaction(leaseId, async (lease) => {
    if (lease.state !== "active" || (lease.expiresAt > 0 && ports.clock() >= lease.expiresAt)) {
      found.outcome = { kind: "skipped", reason: "not_active" };
      return lease;
    }
    if (options.checkLiveRun && (await isRunLive(ports.artifacts, leaseId, ports.clock()))) {
      found.outcome = { kind: "skipped", reason: "live_run" };
      return lease;
    }

    let transient = false;
    let retryAfterSeconds: number | undefined;
    let ok = false;
    for (const resource of [...options.resources].sort(byName)) {
      const result = await options.vault.probeGrant(leaseId, resource, ports.clock(), {
        timeoutMs: options.timeoutMs,
      });
      switch (result.kind) {
        case "provider_revoked": {
          const at = ports.clock();
          const revocation = applyProviderRevocation(lease, at);
          if (!revocation.ok) {
            // The transition table refused: never end a lease on a path the table does not allow.
            found.outcome = { kind: "transient" };
            return lease;
          }
          for (const transition of revocation.value.transitions) {
            await appendTransitionReceipt(ports.receipts(leaseId), transition, at);
          }
          found.outcome = { kind: "revoked", lease: revocation.value.lease };
          return revocation.value.lease;
        }
        case "transient":
          transient = true;
          if (result.retryAfterSeconds !== undefined) {
            retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, result.retryAfterSeconds);
          }
          break;
        case "ok":
          ok = true;
          break;
        case "not_probeable":
          break;
      }
    }

    if (transient) {
      found.outcome = retryAfterSeconds === undefined ? { kind: "transient" } : { kind: "transient", retryAfterSeconds };
    } else {
      found.outcome = ok ? { kind: "ok" } : { kind: "not_probeable" };
    }
    return lease;
  });

  return found.outcome;
}
