/**
 * The `Telemetry` port (D-25). A host supplies a sink; the runtime emits a
 * closed set of scalar-only events so a faulty or curious sink can never
 * learn call arguments, tokens, manifests or error text, and can never change
 * a lease outcome (`safeEmit` swallows every throw).
 */

import type { TeardownStepName, TeardownStepOutcome } from "../lease.js";
import type { Actor, State } from "../transitions.js";

/** Closed union: every field is a scalar and none carries arguments, tokens, error text or a manifest. */
export type TelemetryEvent =
  | {
      readonly name: "call.decided";
      readonly leaseId: string;
      readonly tool: string;
      readonly outcome: "allowed" | "denied";
      readonly reason?: string;
    }
  | {
      readonly name: "lease.transition";
      readonly leaseId: string;
      readonly from: State;
      readonly to: State;
      readonly actor: Actor;
    }
  | {
      readonly name: "teardown.step";
      readonly leaseId: string;
      readonly step: TeardownStepName;
      readonly outcome: TeardownStepOutcome;
    }
  | {
      readonly name: "teardown.blocked";
      readonly leaseId: string;
      readonly reason: "credentials_unavailable";
      readonly resourceCount: number;
    }
  | {
      readonly name: "teardown.fence_takeover";
      readonly leaseId: string;
      readonly previousEpoch: number;
      readonly epoch: number;
    }
  | {
      readonly name: "supervisor.action";
      readonly leaseId: string;
      readonly action: "expired" | "torn_down" | "retried" | "stuck";
    };

/** One synchronous method; a sink that needs I/O must queue internally. */
export interface Telemetry {
  emit(event: TelemetryEvent): void;
}

/** The default sink: drops every event. */
export const NOOP_TELEMETRY: Telemetry = {
  emit(): void {
    // intentionally empty
  },
};

/**
 * Emits `event` to `telemetry` if one is supplied. Every throw from the sink
 * is swallowed: telemetry is observational and must never change an outcome.
 */
export function safeEmit(telemetry: Telemetry | undefined, event: TelemetryEvent): void {
  if (telemetry === undefined) return;
  try {
    telemetry.emit(event);
  } catch {
    // a faulty sink must never alter a lease outcome
  }
}
