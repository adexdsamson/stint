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
import {
  clampedLicenseExpiry,
  DEFAULT_LICENSE_TTL_SECONDS,
  needsRefresh,
  resumeLease,
} from "@stint/core";
import type {
  HeldLicense,
  HostAdapter,
  Lease,
  LeaseStore,
  LicenseClaims,
  LicenseIssuer,
} from "@stint/core";
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
  runResourceQueryVerification,
} from "@stint/proxy";
import type {
  ExecuteStage,
  FetchLike,
  LicenseCustody,
  ProxyDeps,
  SeededCredential,
  TeardownStep,
} from "@stint/proxy";
import { parsePredicate, resolveAuthMode } from "@stint/spec";
import type { Access, AuthMode, VerifiedManifest } from "@stint/spec";

import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { licenseClaimsFromManifest } from "./license-http.js";
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
  /**
   * HOST-SIDE ONLY (D-15): runs the manifest's `resource_query` verifier through the same vault and
   * connector a real call uses. A true predicate completes the lease and auto-chains teardown to its
   * end state; a false one leaves it `active`. It is NOT an MCP tool and the agent has no way to
   * reach it, so an agent's own "done" can never complete a lease (Phase 5 D-03). Resolves with the
   * lease as persisted afterwards. Throws a fixed-text `CliError` when the manifest has no
   * `resource_query` verifier or the profile carries no read binding with a `rowAdapter` for it
   * (a JSON profile cannot carry a function): end such a lease with `stint revoke` instead.
   */
  readonly verifyOutcome: () => Promise<Lease>;
}

/** Refresh the in-memory license once it is this close to expiring. */
export const LICENSE_REFRESH_BEFORE_SECONDS = 60;

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
 * In-memory license custody for ONE lease (D-07, D-17/D-18). The license is held only in this
 * closure: never persisted, never logged, never read back out (`readLicenseToken` is not used) and
 * never handed to the outbound connector (LIC-05). It exists so the runtime can refresh it
 * best-effort per call and so teardown can discard it.
 *
 * Refresh is bounded: `client.reissue` clamps to the lease expiry itself (LIC-03) and we re-clamp
 * the expiry we track. A failed or declined reissue leaves custody unchanged, never moves the lease's
 * `expires_at` and never becomes a deny (D-17): the call that triggered it proceeds.
 */
interface LicenseRuntime {
  readonly custody: LicenseCustody;
  /** Issues the initial license (best-effort). */
  readonly start: (now: number, leaseExpiresAt: number) => Promise<void>;
  /** Re-issues when within the refresh window (best-effort, never throws). */
  readonly refresh: (now: number) => Promise<void>;
}

function createLicenseRuntime(input: {
  readonly mode: AuthMode;
  readonly client: LicenseIssuerClient | undefined;
  readonly claims: LicenseClaims;
  readonly leaseStore: LeaseStore;
  readonly leaseId: string;
}): LicenseRuntime {
  const { client, claims, leaseStore, leaseId } = input;
  // A hosted/hybrid lease always has a license at its publisher (issued at create), whether or not this
  // process holds a copy; a delegated lease has none.
  const state: { licensed: boolean; held: HeldLicense | undefined; exp: number } = {
    licensed: input.mode !== "delegated",
    held: undefined,
    exp: Number.NEGATIVE_INFINITY,
  };
  let inflight: Promise<void> | undefined;
  // Re-read after every await: discard() may have run while a publisher call was in flight.
  const isLicensed = (): boolean => state.licensed;

  const custody: LicenseCustody = {
    hasLicense: () => state.licensed,
    discard: () => {
      state.licensed = false;
      state.held = undefined;
      state.exp = Number.NEGATIVE_INFINITY;
    },
  };

  async function start(now: number, leaseExpiresAt: number): Promise<void> {
    if (client === undefined || !isLicensed()) return;
    try {
      const held = await client.issue(claims, now, leaseExpiresAt);
      const exp = clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt);
      if (exp === null || !isLicensed()) return;
      state.held = held;
      state.exp = exp;
    } catch {
      // Best-effort (D-17): an unreachable publisher at start adds no deny; per-call refresh retries.
    }
  }

  async function reissue(now: number): Promise<void> {
    try {
      const current = await leaseStore.load(leaseId);
      if (current?.state !== "active") return;
      const next = await client?.reissue(claims, now, current.expiresAt);
      if (next === undefined || next === null) return; // declined or lapsed: custody unchanged
      const exp = clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, current.expiresAt);
      if (exp === null || !isLicensed()) return;
      state.held = next;
      state.exp = exp;
    } catch {
      // Best-effort (D-17): a failed reissue never moves expiry and never denies the call.
    }
  }

  function refresh(now: number): Promise<void> {
    if (client === undefined || !isLicensed()) return Promise.resolve();
    if (state.held !== undefined && !needsRefresh(state.exp, now, LICENSE_REFRESH_BEFORE_SECONDS)) {
      return Promise.resolve();
    }
    inflight ??= reissue(now).finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return { custody, start, refresh };
}

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
  const license = createLicenseRuntime({
    mode,
    client: options.licenseIssuer,
    claims: licenseClaimsFromManifest(leaseId, verified.manifest),
    leaseStore,
    leaseId,
  });
  await license.start(now, lease.expiresAt);
  const teardownSteps: readonly TeardownStep[] = createDefaultTeardownSteps(
    receiptStore,
    privateKey,
    vault,
    teardownLicense(
      mode,
      verified.manifest.auth.hosted?.kid ?? "publisher",
      options.licenseIssuer,
      license.custody,
    ),
    { url: verified.manifest.cleanup === null ? null : verified.manifest.cleanup.hook.url },
  );

  // The license is refreshed best-effort BEFORE an allowed call and is never passed on: the credential
  // the connector receives stays `{ accessToken }` (LIC-05).
  const vaultStage = createVaultExecuteStage(vault, connector);
  const execute: ExecuteStage = {
    async execute(ctx, callNow) {
      await license.refresh(callNow);
      return await vaultStage.execute(ctx, callNow);
    },
  };

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
    execute,
    approve: createApprovalDispatcher(adapter, verified.manifest.approvals.timeout_seconds, clock),
    enforceCaps: createCapEnforcer(),
    teardownSteps,
  };

  const server = createLeaseProxyServer(proxyDeps);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(transport);

  const verifyOutcome = async (): Promise<Lease> => {
    const verifier = verified.manifest.job.verifier;
    if (verifier.type !== "resource_query") {
      throw new CliError(
        EXIT_CODES.usage,
        "The manifest has no resource_query verifier; end the lease with stint revoke.",
      );
    }
    const ast = parsePredicate(verifier.predicate);
    // Only a READ binding may serve the synthetic verifier read (it POSTs an empty body).
    const binding = Object.values(profile.bindings).find(
      (b) => b.resource === verifier.resource && b.access === "read" && b.rowAdapter !== undefined,
    );
    if (!ast.ok || binding === undefined) {
      throw new CliError(
        EXIT_CODES.usage,
        "The run profile has no read binding with a row adapter for the verifier; end the lease with stint revoke.",
      );
    }
    const current = await leaseStore.load(leaseId);
    if (current?.state !== "active") {
      throw new CliError(
        EXIT_CODES.wrongState,
        "The lease is not active, so it cannot be verified.",
      );
    }
    await runResourceQueryVerification(
      {
        leaseStore,
        receiptStore,
        leaseId,
        teardownSteps,
        vault,
        connector,
        binding,
        ast: ast.value,
      },
      clock(),
    );
    const after = await leaseStore.load(leaseId);
    if (after === undefined) throw new CliError(EXIT_CODES.internal, "Internal error.");
    return after;
  };

  return { closed, close: () => server.close(), verifyOutcome };
}
