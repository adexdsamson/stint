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
import type { HostAdapter, LicenseIssuer } from "@stint/core";
import type { LicenseIssuerClient } from "@stint/core/license-issuer";
import {
  appendTransitionReceipt,
  createApprovalDispatcher,
  createCapEnforcer,
  createCredentialVault,
  createDefaultTeardownSteps,
  createLeaseProxyServer,
  createRestOutboundConnector,
  createVaultExecuteStage,
} from "@stint/proxy";
import type {
  FetchLike,
  LicenseCustody,
  ProxyDeps,
  SeededCredential,
  TeardownStep,
} from "@stint/proxy";
import { resolveAuthMode } from "@stint/spec";
import type { Access, AuthMode, VerifiedManifest } from "@stint/spec";

import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { isLoopbackHttp } from "./loopback.js";
import type { RunProfile } from "./profile.js";

export interface RunLeaseOptions {
  readonly leaseId: string;
  readonly root: string;
  /** Where the MCP protocol flows: `StdioServerTransport` in the CLI, an in-memory half in tests. */
  readonly transport: Transport;
  /** Renders and proposes approvals; core owns the deny-by-default decision. */
  readonly adapter: HostAdapter;
  readonly deps: Pick<
    CliDeps,
    "storeFactory" | "receiptStoreFactory" | "clock" | "credentials" | "keys"
  >;
  /** The trust-verified manifest the lease is bound to (re-checked here against the bound hash). */
  readonly verified: VerifiedManifest;
  readonly profile: RunProfile;
  /** In-memory vault seed (`--credentials`); never persisted. */
  readonly credentials?: Readonly<Record<string, SeededCredential>> | undefined;
  /** Downstream fetch override (tests); production uses global `fetch`. */
  readonly outboundFetch?: FetchLike | undefined;
  /**
   * The verify-then-mint publisher client for a hosted/hybrid lease (built from the persisted
   * publisher binding). Absent for a purely delegated lease. The license it mints is held
   * in-memory only and is never handed to an outbound connector (LIC-05).
   */
  readonly licenseIssuer?: LicenseIssuerClient | undefined;
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

/** Applies the profile's identifier -> URL map before delegating; unmapped identifiers pass through unchanged (Pitfall 3). */
function mapEndpoints(
  base: FetchLike,
  endpoints: Readonly<Record<string, string>> | undefined,
): FetchLike {
  if (endpoints === undefined) return base;
  return (input, init) => {
    const target = Object.hasOwn(endpoints, input) ? endpoints[input] : undefined;
    return base(target ?? input, init);
  };
}

const NO_LICENSE_IN_RUN = "License issuance is not available here.";

/**
 * The `invalidate_license` collaborator for this run's teardown (mirrors teardown-support's
 * honesty rules): a delegated lease has no license (`not_applicable`); a hosted/hybrid lease with
 * no reachable publisher client cannot tell the publisher, so invalidation fails honestly.
 */
function teardownLicense(
  mode: AuthMode,
  kid: string,
  client: LicenseIssuerClient | undefined,
  custody: LicenseCustody,
): { readonly issuer: LicenseIssuer; readonly custody: LicenseCustody } {
  const refuse = (): Promise<never> => Promise.reject(new Error(NO_LICENSE_IN_RUN));
  const base = { kid, issue: refuse, reissue: refuse };
  if (mode === "delegated") {
    return {
      issuer: { ...base, invalidate: () => Promise.resolve() },
      custody: { hasLicense: () => false, discard: () => undefined },
    };
  }
  return {
    issuer: {
      ...base,
      invalidate: (id) =>
        client === undefined
          ? Promise.reject(new Error("No publisher binding is available for the lease."))
          : client.invalidate(id),
    },
    custody,
  };
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

  // Plain http to the AS is permitted ONLY for a loopback token endpoint (Pitfall 2, D-16); never a blanket switch.
  const vault = createCredentialVault(
    profile.oauth,
    clock,
    isLoopbackHttp(profile.oauth.as.token_endpoint ?? "") ? { allowInsecureRequests: true } : {},
  );
  if (options.credentials !== undefined) {
    deps.credentials.seedVault(vault, leaseId, options.credentials);
  }

  const connector = createRestOutboundConnector(
    mapEndpoints(options.outboundFetch ?? fetch, profile.endpoints),
  );

  // Real teardown steps (Pattern 3/Pitfall 8): without them a mid-run revocation would leave the lease
  // `tearing_down` and the verifier path could not reach `cleaned_up`.
  const { privateKey } = await deps.keys.loadOrCreate(root);
  const mode = resolveAuthMode(verified.manifest);
  const licenseCustody: LicenseCustody = {
    hasLicense: () => mode !== "delegated",
    discard: () => undefined,
  };
  const teardownSteps: readonly TeardownStep[] = createDefaultTeardownSteps(
    receiptStore,
    privateKey,
    vault,
    teardownLicense(
      mode,
      verified.manifest.auth.hosted?.kid ?? "publisher",
      options.licenseIssuer,
      licenseCustody,
    ),
    { url: verified.manifest.cleanup === null ? null : verified.manifest.cleanup.hook.url },
  );

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
    execute: createVaultExecuteStage(vault, connector),
    approve: createApprovalDispatcher(adapter, verified.manifest.approvals.timeout_seconds, clock),
    enforceCaps: createCapEnforcer(),
    teardownSteps,
  };

  const server = createLeaseProxyServer(proxyDeps);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(transport);
  return { closed, close: () => server.close() };
}
