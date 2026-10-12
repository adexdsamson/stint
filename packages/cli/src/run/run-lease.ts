/**
 * `runLease`: the CLI's thin host over `@stint/runtime`'s `createLeaseRuntime`.
 * It builds the runtime ports from its deps and store root (file-backed
 * defaults for any seam not supplied), calls the runtime and maps a
 * `RuntimeError` to a `CliError`. No enforcement logic lives here, and nothing
 * on this path writes to `process.stdout`: under stdio it is the MCP JSON-RPC
 * channel.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HostAdapter, Lease } from "@stint/core";
import type { LicenseIssuerClient } from "@stint/core/license-issuer";
import type { FetchLike, SeededCredential } from "@stint/proxy";
import { createLeaseRuntime, LICENSE_REFRESH_BEFORE_SECONDS } from "@stint/runtime";
import type { RunningLease as RuntimeRunningLease } from "@stint/runtime";
import type { VerifiedManifest } from "@stint/spec";

import type { CliDeps } from "../deps.js";
import { toCliError } from "../runtime-errors.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import type { RunProfile } from "./profile.js";

export { LICENSE_REFRESH_BEFORE_SECONDS };

/** What a served lease hands back; defined by the runtime. */
export type RunningLease = RuntimeRunningLease;

export interface RunLeaseOptions {
  readonly leaseId: string;
  readonly root: string;
  /** Where the MCP protocol flows: `StdioServerTransport` in the CLI, an in-memory half in tests. */
  readonly transport: Transport;
  /** Renders and proposes approvals; core owns the deny-by-default decision. */
  readonly adapter: HostAdapter;
  readonly deps: Pick<CliDeps, "storeFactory" | "receiptStoreFactory" | "clock" | "keys"> &
    Partial<
      Pick<
        CliDeps,
        "credentials" | "loadTrustStore" | "secrets" | "artifacts" | "keyProvider" | "telemetry"
      >
    >;
  /** The trust-verified manifest the lease is bound to (re-checked here against the bound hash). */
  readonly verified: VerifiedManifest;
  readonly profile: RunProfile;
  /** Credentials copied into the secret store when it holds none for a resource. */
  readonly credentials?: Readonly<Record<string, SeededCredential>> | undefined;
  /** Downstream fetch override (tests); production uses global `fetch`. */
  readonly outboundFetch?: FetchLike | undefined;
  /** The verify-then-mint publisher client for a hosted/hybrid lease. Absent for a purely delegated lease. */
  readonly licenseIssuer?: LicenseIssuerClient | undefined;
  /** How often, in milliseconds, a call waiting for an approval checks whether the lease has ended (default 1000; tests use a small value). */
  readonly approvalWatchMs?: number | undefined;
  /** How often, in milliseconds, the run checks its own lease (default 5000; tests use a small value). */
  readonly leaseWatchMs?: number | undefined;
  /** Seconds a lease may sit idle before the run probes its own grant (default 900; 0 turns the probe off). */
  readonly probeIntervalSeconds?: number | undefined;
}

export async function runLease(options: RunLeaseOptions): Promise<RunningLease> {
  const { root, deps, ...rest } = options;
  const ports = buildRuntimePorts(deps, root);
  let running: RuntimeRunningLease;
  try {
    running = await createLeaseRuntime(ports, rest);
  } catch (error) {
    throw toCliError(error);
  }
  return {
    closed: running.closed,
    close: running.close,
    ended: running.ended,
    verifyOutcome: async (): Promise<Lease> => {
      try {
        return await running.verifyOutcome();
      } catch (error) {
        throw toCliError(error);
      }
    },
  };
}
