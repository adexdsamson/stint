/**
 * The ports a host hands to `@stint/runtime` (D-24). The runtime never reaches
 * for the file system, the environment or a process; everything it needs
 * arrives through this bundle, so any host (CLI, IDE extension, server) can
 * drive the same lease lifecycle. This module names ports only, never a
 * concrete backend.
 */

import type {
  KeyProvider,
  LeaseArtifactStore,
  LeaseStore,
  ReceiptStore,
  SecretStore,
  Telemetry,
} from "@stint/core";
import type { TrustStore } from "@stint/spec";

export interface RuntimePorts {
  readonly leases: LeaseStore;
  /** The receipt store for one lease (receipts are per-lease chains). */
  readonly receipts: (leaseId: string) => ReceiptStore;
  /** Epoch SECONDS, matching lease timestamps. */
  readonly clock: () => number;
  /** Optional observational sink; a throwing sink never changes an outcome. */
  readonly telemetry?: Telemetry;
  /** Opaque custody of the secret values a live lease holds (RT-02). */
  readonly secrets: SecretStore;
  /** Per-lease non-secret artifacts: envelope, publisher binding, grant manifest (RT-02). */
  readonly artifacts: LeaseArtifactStore;
  /** The runtime's checkpoint signing key and the public keys a verifier may use (RT-02). */
  readonly keys: KeyProvider;
  /** Resolves the publisher trust store each time it is needed. */
  readonly trust: () => Promise<TrustStore>;
  /** Optional HTTP transport for publisher calls; absent means the global `fetch`. */
  readonly fetch?: typeof fetch;
}
