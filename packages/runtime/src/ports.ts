/**
 * The ports a host hands to `@stint/runtime` (D-24). The runtime never reaches
 * for the file system, the environment or a process; everything it needs
 * arrives through this bundle, so any host (CLI, IDE extension, server) can
 * drive the same lease lifecycle.
 */

import type { LeaseStore, ReceiptStore, Telemetry } from "@stint/core";

export interface RuntimePorts {
  readonly leases: LeaseStore;
  /** The receipt store for one lease (receipts are per-lease chains). */
  readonly receipts: (leaseId: string) => ReceiptStore;
  /** Epoch SECONDS, matching lease timestamps. */
  readonly clock: () => number;
  /** Optional observational sink; a throwing sink never changes an outcome. */
  readonly telemetry?: Telemetry;
}
