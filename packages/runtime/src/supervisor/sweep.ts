/**
 * `runSweep`: one store-driven sweep (Phase 9 SUP-01, D-05). It scans the
 * lease store, settles every `granted` or `active` lease whose time has run
 * out and tears every ended lease down through the fenced `resolveTeardown`
 * path. It is host-agnostic: the clock, the stores and the secret custody all
 * arrive through `RuntimePorts`; the host owns the loop, the signals and the
 * terminal.
 *
 * Nothing here enforces expiry (ALP 7.5): a live `run` already denies every
 * call past `expiresAt`, and no timer is armed. The sweep only triggers the
 * settle and teardown that expiry makes necessary.
 *
 * Isolation: each lease runs in its own try/catch. A lease another driver
 * holds (`TeardownFencedError`) or whose credentials are missing
 * (`TeardownBlockedError`, the supervisor's stuck handling is a later plan)
 * adds no event; any other failure is reported as a `lease_error` carrying
 * only the lease id, and the sweep continues. A record the store could not
 * read is reported by id and closed reason, never by contents.
 */

import { safeEmit } from "@stint/core";
import type { Lease, LeaseScanEntry } from "@stint/core";
import { TeardownBlockedError, TeardownFencedError } from "@stint/proxy";
import type { TeardownStep } from "@stint/proxy";

import type { RuntimePorts } from "../ports.js";
import { resolveTeardown } from "../resolve-teardown.js";
import { settleExpired } from "../settle-expired.js";

/** One thing the sweep did or found. Closed union; carries no secret, token, record content or error text. */
export type SweepEvent =
  | { readonly kind: "expired"; readonly leaseId: string }
  | { readonly kind: "torn_down"; readonly leaseId: string; readonly lease: Lease }
  | {
      readonly kind: "corrupt_record";
      readonly leaseId: string;
      readonly unreadable: "corrupt" | "io_error";
    }
  | { readonly kind: "lease_error"; readonly leaseId: string };

export interface SweepReport {
  readonly events: readonly SweepEvent[];
  /** How many store entries the sweep looked at (readable or not). */
  readonly scanned: number;
}

export interface RunSweepOptions {
  /** Lets a host (or a test) wrap the five default teardown steps. */
  readonly decorateSteps?: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
  /** Fence lifetime in seconds for the teardown passes this sweep runs. */
  readonly fenceTtlSeconds?: number;
  /** Called for each event as it happens and awaited before the sweep moves on. A failing callback never stops the sweep. */
  readonly onEvent?: (event: SweepEvent) => void | Promise<void>;
}

/** What the sweep does with a lease in a given state. Closed so a new state is a compile error. */
type Route = "settle_then_teardown" | "teardown" | "nothing";

function route(lease: Lease, now: number): Route {
  switch (lease.state) {
    case "granted":
    case "active":
      return lease.expiresAt > 0 && now >= lease.expiresAt ? "settle_then_teardown" : "nothing";
    case "completed":
    case "expired":
    case "revoked":
    case "failed":
    case "tearing_down":
      return "teardown";
    case "cleanup_incomplete":
    case "cleaned_up":
    case "declined":
    case "proposed":
      return "nothing";
  }
}

function isLanded(state: Lease["state"]): boolean {
  return state === "cleaned_up" || state === "cleanup_incomplete";
}

/** Runs one sweep over every lease in `ports.leases`. */
export async function runSweep(ports: RuntimePorts, options: RunSweepOptions = {}): Promise<SweepReport> {
  const events: SweepEvent[] = [];
  const emit = async (event: SweepEvent): Promise<void> => {
    events.push(event);
    try {
      await options.onEvent?.(event);
    } catch {
      // a failing renderer must not stop the sweep
    }
  };

  const entries: readonly LeaseScanEntry[] = await ports.leases.scan();

  for (const entry of entries) {
    if ("unreadable" in entry) {
      await emit({ kind: "corrupt_record", leaseId: entry.id, unreadable: entry.unreadable });
      continue;
    }
    const leaseId = entry.id;
    try {
      let lease = entry.lease;
      let action = route(lease, ports.clock());
      if (action === "settle_then_teardown") {
        const settled = await settleExpired(ports, leaseId);
        lease = settled.lease;
        if (settled.settled) {
          safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "expired" });
          await emit({ kind: "expired", leaseId });
        }
        action = route(lease, ports.clock());
      }
      if (action !== "teardown") continue;

      const landedBefore = isLanded(lease.state);
      const resolved = await resolveTeardown(ports, {
        leaseId,
        ...(options.decorateSteps === undefined ? {} : { decorateSteps: options.decorateSteps }),
        ...(options.fenceTtlSeconds === undefined ? {} : { fenceTtlSeconds: options.fenceTtlSeconds }),
      });
      const finished = await resolved.run(ports.clock());
      if (!landedBefore && isLanded(finished.state)) {
        safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "torn_down" });
        await emit({ kind: "torn_down", leaseId, lease: finished });
      }
    } catch (error) {
      if (error instanceof TeardownFencedError || error instanceof TeardownBlockedError) continue;
      await emit({ kind: "lease_error", leaseId });
    }
  }

  return { events, scanned: entries.length };
}
