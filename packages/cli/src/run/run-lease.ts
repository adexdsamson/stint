/**
 * `runLease`: composes the existing proxy seams into a live, per-lease MCP
 * server behind an INJECTED `Transport` (Pattern 4, D-01). No enforcement logic
 * lives here: policy, caps, approvals, the vault boundary and receipts are all
 * the proxy's. The CLI passes `StdioServerTransport`; tests pass one half of an
 * `InMemoryTransport` pair and connect a real MCP `Client` to the other.
 *
 * Nothing on this path writes to `process.stdout`: under stdio it is the MCP
 * JSON-RPC channel (Pitfall 4).
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resumeLease } from "@stint/core";
import type { HostAdapter } from "@stint/core";
import {
  appendTransitionReceipt,
  createApprovalDispatcher,
  createCapEnforcer,
  createCredentialVault,
  createLeaseProxyServer,
  createRestOutboundConnector,
  createVaultExecuteStage,
} from "@stint/proxy";
import type { FetchLike, ProxyDeps, SeededCredential } from "@stint/proxy";
import type { Access, VerifiedManifest } from "@stint/spec";

import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import type { RunProfile } from "./profile.js";

export interface RunLeaseOptions {
  readonly leaseId: string;
  readonly root: string;
  /** Where the MCP protocol flows: `StdioServerTransport` in the CLI, an in-memory half in tests. */
  readonly transport: Transport;
  /** Renders and proposes approvals; core owns the deny-by-default decision. */
  readonly adapter: HostAdapter;
  readonly deps: Pick<CliDeps, "storeFactory" | "receiptStoreFactory" | "clock" | "credentials">;
  /** The trust-verified manifest the lease is bound to (re-checked here against the bound hash). */
  readonly verified: VerifiedManifest;
  readonly profile: RunProfile;
  /** In-memory vault seed (`--credentials`); never persisted. */
  readonly credentials?: Readonly<Record<string, SeededCredential>> | undefined;
  /** Downstream fetch override (tests); production uses global `fetch`. */
  readonly outboundFetch?: FetchLike | undefined;
}

export interface RunningLease {
  /** Resolves when the transport closes (agent disconnect or `close()`). */
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
}

/** Flattens `manifest.scopes` into the two arrays the proxy checks (Open Q8: the Phase-4 cross-product is inherited, not fixed here). */
function flattenScopes(verified: VerifiedManifest): {
  readonly scopes: readonly Access[];
  readonly resources: readonly string[];
} {
  const scopes = new Set<Access>();
  const resources = new Set<string>();
  for (const scope of verified.manifest.scopes) {
    resources.add(scope.resource);
    for (const access of scope.access) scopes.add(access);
  }
  return { scopes: [...scopes], resources: [...resources] };
}

export async function runLease(options: RunLeaseOptions): Promise<RunningLease> {
  const { leaseId, root, transport, adapter, deps, verified, profile } = options;
  const clock = deps.clock;
  const leaseStore = deps.storeFactory(root);
  const receiptStore = deps.receiptStoreFactory(root, leaseId);

  const lease = await leaseStore.load(leaseId);
  if (lease === undefined) throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  if (lease.state !== "active") {
    throw new CliError(
      EXIT_CODES.wrongState,
      "The lease is not active, so there is nothing to run.",
    );
  }

  // Re-verify the bound manifest hash on every run (D-21). A mismatch fails the lease, honestly receipted.
  const now = clock();
  const resumed = resumeLease(lease, verified, now);
  if (!resumed.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
  if (resumed.value.transition !== undefined) {
    await leaseStore.save(resumed.value.lease);
    await appendTransitionReceipt(receiptStore, resumed.value.transition, now);
    throw new CliError(
      EXIT_CODES.wrongState,
      "The stored manifest no longer matches the lease's bound hash; the lease was failed. Run cleanup to finish teardown.",
    );
  }

  const vault = createCredentialVault(profile.oauth, clock);
  if (options.credentials !== undefined) {
    deps.credentials.seedVault(vault, leaseId, options.credentials);
  }

  const { scopes, resources } = flattenScopes(verified);
  const proxyDeps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog: profile.catalog,
    bindings: profile.bindings,
    grantedScopes: scopes,
    grantedResources: resources,
    limits: verified.manifest.limits,
    approvals: verified.manifest.approvals,
    clock,
    execute: createVaultExecuteStage(vault, createRestOutboundConnector(options.outboundFetch)),
    approve: createApprovalDispatcher(adapter, verified.manifest.approvals.timeout_seconds, clock),
    enforceCaps: createCapEnforcer(),
    // `teardownSteps` is deliberately omitted: the honest step set needs the cleanup hook and license custody
    // this command does not hold. A mid-run revocation leaves the lease `tearing_down`; `stint cleanup` finishes it.
  };

  const server = createLeaseProxyServer(proxyDeps);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(transport);
  return { closed, close: () => server.close() };
}
