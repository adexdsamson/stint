/**
 * `createLeaseRuntime`: composes the proxy seams into a live, per-lease MCP
 * server behind an INJECTED `Transport`, from `RuntimePorts` alone. No
 * enforcement logic lives here: policy, caps, approvals, the vault boundary and
 * receipts are all the proxy's. A host passes its transport (stdio for a CLI,
 * an in-memory half in tests).
 *
 * The runtime never writes to a standard stream: under stdio the host's stdout
 * is the MCP JSON-RPC channel. Every failure is a fixed-text `RuntimeError`.
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
  RunHeartbeat,
} from "@stint/core";
import type { LicenseIssuerClient } from "@stint/core/license-issuer";
import {
  DEFAULT_FENCE_TTL_SECONDS,
  DEFAULT_OAUTH_TIMEOUT_MS,
  TeardownBlockedError,
  TeardownFencedError,
  appendTransitionReceipt,
  createApprovalDispatcher,
  createCapEnforcer,
  createCredentialVault,
  createDefaultTeardownSteps,
  createLeaseProxyServer,
  createVaultExecuteStage,
  runTeardown,
} from "@stint/proxy";
import type {
  ExecuteStage,
  FetchLike,
  LicenseCustody,
  ProxyDeps,
  SeededCredential,
  TeardownFenceConfig,
  TeardownStep,
} from "@stint/proxy";
import { resolveAuthMode } from "@stint/spec";
import type { Access, AuthMode, VerifiedManifest } from "@stint/spec";

import { expectedCredentialResources, missingCredentials, seedLeaseCredentials } from "./custody.js";
import { RuntimeError } from "./errors.js";
import { licenseClaimsFromManifest } from "./license-http.js";
import { isLoopbackHttp } from "./loopback.js";
import { createRuntimeOutboundConnector } from "./outbound.js";
import type { RuntimePorts } from "./ports.js";
import { enrichFromProfile } from "./profile.js";
import type { RunProfile } from "./profile.js";
import { settleExpired } from "./settle-expired.js";
import { RUN_HEARTBEAT_INTERVAL_SECONDS, writeRunHeartbeat } from "./supervisor/heartbeat.js";
import { probeBackoffSeconds, probeLeaseGrants } from "./supervisor/probe.js";
import { evaluateVerifier } from "./verify-outcome.js";

export interface LeaseRuntimeOptions {
  readonly leaseId: string;
  /** Where the MCP protocol flows: a stdio transport in a CLI, an in-memory half in tests. */
  readonly transport: Transport;
  /** Renders and proposes approvals; core owns the deny-by-default decision. */
  readonly adapter: HostAdapter;
  /** The trust-verified manifest the lease is bound to (re-checked here against the bound hash). */
  readonly verified: VerifiedManifest;
  readonly profile: RunProfile;
  /** Credentials to copy into the secret store when it holds none for a resource (put-if-absent). */
  readonly credentials?: Readonly<Record<string, SeededCredential>> | undefined;
  /** Downstream fetch override (tests); production uses the global `fetch`. */
  readonly outboundFetch?: FetchLike | undefined;
  /**
   * The verify-then-mint publisher client for a hosted or hybrid lease. Absent for a purely
   * delegated lease. The license it mints is held in memory only and is never handed to an
   * outbound connector.
   */
  readonly licenseIssuer?: LicenseIssuerClient | undefined;
  /** How often, in milliseconds, a call waiting for an approval checks whether the lease has ended (default 1000). */
  readonly approvalWatchMs?: number | undefined;
  /**
   * How often, in milliseconds, the run checks its own lease: heartbeat, expiry, an end by another
   * process, and the idle probe (default 5000). Tests use a small value.
   */
  readonly leaseWatchMs?: number | undefined;
  /**
   * How long, in seconds, a lease may sit idle (no call, no probe) before the run asks the provider
   * whether its grant is still alive (default 900; 0 turns the probe off).
   */
  readonly probeIntervalSeconds?: number | undefined;
}

/** Why a served lease ended, as the run found it. `unavailable` means the record is gone or no reason can be read from it. */
export type LeaseEndReason = "expired" | "revoked" | "completed" | "failed" | "unavailable";

/** What the run did about the end of its lease. Closed union; carries no secret, token or error text. */
export interface LeaseEnded {
  readonly reason: LeaseEndReason;
  /**
   * `cleaned_up` and `cleanup_incomplete`: this run tore the lease down. `other_driver`: another
   * driver holds the pass or already landed it, so this run did nothing. `blocked`: a recorded
   * credential is unavailable. `not_run`: the lease record is gone or teardown could not start.
   */
  readonly teardown: "cleaned_up" | "cleanup_incomplete" | "other_driver" | "blocked" | "not_run";
  /** The resources whose credentials are unavailable, when `teardown` is `blocked`. */
  readonly blockedResources?: readonly string[];
}

export interface RunningLease {
  /** Resolves when the transport closes (agent disconnect or `close()`). */
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
  /**
   * Resolves once, and never rejects, when the lease ends while this run serves it (expiry, a
   * revocation, completion or failure by any process): by then the run has torn the lease down (or
   * left it to the driver that holds it), written its final heartbeat and begun closing the
   * transport. It stays pending when the transport closes first.
   */
  readonly ended: Promise<LeaseEnded>;
  /**
   * HOST-SIDE ONLY: runs the manifest's verifier (`resource_query` through the same vault and connector
   * a real call uses, or `user_confirm` through the host adapter) by the same function the standalone
   * `verify-outcome` command uses. A pass completes the lease and auto-chains teardown to its end state;
   * a fail leaves it `active`. It is not an MCP tool and the agent has no way to reach it, so an agent's
   * own "done" can never complete a lease. Resolves with the lease as persisted afterwards. Rejects with a
   * fixed-text `RuntimeError` when the manifest has a `none` verifier or the profile carries no read
   * binding with a `rowAdapter` for a `resource_query` verifier: end such a lease with a revoke instead.
   */
  readonly verifyOutcome: () => Promise<Lease>;
}

const DEFAULT_LEASE_WATCH_MS = 5000;
const DEFAULT_PROBE_INTERVAL_SECONDS = 900;

/** Refresh the in-memory license once it is this close to expiring. */
export const LICENSE_REFRESH_BEFORE_SECONDS = 60;

/** Flattens `manifest.scopes` into the two arrays the proxy checks. */
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

const NO_LICENSE_IN_RUN = "License issuance is not available here.";

/**
 * In-memory license custody for ONE lease. The license is held only in this
 * closure: never persisted, never logged, never read back out and never handed
 * to the outbound connector. It exists so the runtime can refresh it
 * best-effort per call and so teardown can discard it.
 *
 * Refresh is bounded: `client.reissue` clamps to the lease expiry itself and we
 * re-clamp the expiry we track. A failed or declined reissue leaves custody
 * unchanged, never moves the lease's `expires_at` and never becomes a deny: the
 * call that triggered it proceeds.
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
      // Best-effort: an unreachable publisher at start adds no deny; per-call refresh retries.
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
      // Best-effort: a failed reissue never moves expiry and never denies the call.
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
 * The `invalidate_license` collaborator for this run's teardown: a delegated
 * lease has no license (`not_applicable`); a hosted/hybrid lease with no
 * reachable publisher client cannot tell the publisher, so invalidation fails
 * honestly.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLanded(state: Lease["state"]): boolean {
  return state === "cleaned_up" || state === "cleanup_incomplete";
}

/** Whether a lease has run out of time by `now`. */
function isPastExpiry(lease: Lease, now: number): boolean {
  return lease.expiresAt > 0 && now >= lease.expiresAt;
}

/** The `from` state of the newest `begin_teardown` transition in the verified chain, when it is an end reason. */
async function reasonFromChain(receipts: ReturnType<RuntimePorts["receipts"]>): Promise<LeaseEndReason> {
  const chain = await receipts.load("verified");
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const entry = chain[i];
    if (entry?.type !== "transition") continue;
    const payload: unknown = entry.payload;
    if (!isRecord(payload) || payload.event !== "begin_teardown") continue;
    const from = payload.from;
    return from === "expired" || from === "revoked" || from === "completed" || from === "failed"
      ? from
      : "unavailable";
  }
  return "unavailable";
}

/**
 * Serves one lease as an MCP proxy over `options.transport`, using only the
 * ports: leases, receipts, secrets, artifacts and keys. Credentials the store
 * holds are loaded through on demand and a refreshed token is written back, so
 * a later teardown revokes the current grant. Teardown shares the same secret
 * store, so a lease that ends in this process leaves no secret behind.
 *
 * @experimental The runtime surface is not yet stable.
 */
export async function createLeaseRuntime(
  ports: RuntimePorts,
  options: LeaseRuntimeOptions,
): Promise<RunningLease> {
  const { leaseId, transport, adapter, verified, profile } = options;
  const clock = ports.clock;
  const leaseStore = ports.leases;
  const receiptStore = ports.receipts(leaseId);

  const lease = await leaseStore.load(leaseId);
  if (lease === undefined) throw new RuntimeError("lease_not_found", "Lease not found.");
  if (lease.state !== "active") {
    throw new RuntimeError("wrong_state", "The lease is not active, so there is nothing to run.");
  }

  // Re-verify the bound manifest hash on every run. A mismatch fails the lease, honestly receipted.
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

  // Credentials come from the store; given ones are copied in first (put-if-absent, so a stale
  // file never overwrites a rotated refresh token). Plain http to the AS is permitted ONLY for a
  // loopback token endpoint; never a blanket switch.
  if (options.credentials !== undefined) {
    await seedLeaseCredentials(ports, leaseId, options.credentials, {
      enrich: enrichFromProfile(profile, verified.manifest),
      manifest: verified.manifest,
    });
  }
  const vault = createCredentialVault(() => profile.oauth, clock, {
    secrets: ports.secrets,
    allowInsecureRequests: isLoopbackHttp(profile.oauth.as.token_endpoint ?? ""),
  });

  // `lease.jobParameters` is bound once at create and never changes, so reading it from the
  // lease loaded above is the same value every call would see.
  const connector = createRuntimeOutboundConnector({
    fetchImpl: options.outboundFetch ?? fetch,
    ...(profile.endpoints === undefined ? {} : { endpoints: profile.endpoints }),
    jobParameters: () => lease.jobParameters,
  });

  // Real teardown steps: without them a mid-run revocation would leave the lease `tearing_down`
  // and the verifier path could not reach `cleaned_up`.
  const { privateKey } = await ports.keys.loadOrCreate();
  const mode = resolveAuthMode(verified.manifest);
  const license = createLicenseRuntime({
    mode,
    client: options.licenseIssuer,
    claims: licenseClaimsFromManifest(leaseId, verified.manifest),
    leaseStore,
    leaseId,
  });
  await license.start(now, lease.expiresAt);
  const expectedResources = await expectedCredentialResources(ports, leaseId, verified.manifest);
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
    { expectedResources, secrets: ports.secrets },
  );

  // The license is refreshed best-effort BEFORE an allowed call and is never passed on: the credential
  // the connector receives stays `{ accessToken }`.
  const vaultStage = createVaultExecuteStage(vault, connector);
  // The run's own idle probe schedule (D-18): a call is activity, so it pushes the next probe out.
  const probeIntervalSeconds = options.probeIntervalSeconds ?? DEFAULT_PROBE_INTERVAL_SECONDS;
  const probe = { nextAt: lease.grantedAt + probeIntervalSeconds, failures: 0 };
  const execute: ExecuteStage = {
    async execute(ctx, callNow) {
      probe.nextAt = callNow + probeIntervalSeconds;
      probe.failures = 0;
      await license.refresh(callNow);
      return await vaultStage.execute(ctx, callNow);
    },
  };

  // Every in-process teardown driver of a live run is fenced (Phase 9 D-09): a call-triggered teardown and
  // a verifier completion both hold the lease-record fence, so a supervisor or a user command cannot run
  // the same pass at the same time. The clock is read live for every fence time.
  const teardownFence: TeardownFenceConfig = { clock, ttlSeconds: DEFAULT_FENCE_TTL_SECONDS };

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
    teardownFence,
    ...(ports.telemetry === undefined ? {} : { telemetry: ports.telemetry }),
    ...(options.approvalWatchMs === undefined ? {} : { approvalWatchMs: options.approvalWatchMs }),
  };

  const server = createLeaseProxyServer(proxyDeps);

  // The watcher (D-06, D-07): one interval for the heartbeat, expiry, an end by another process and
  // the idle probe. `stopped` is set once the transport closes or the run ends; after it nothing writes.
  const watch: { timer: ReturnType<typeof setInterval> | undefined; polling: boolean; stopped: boolean } = {
    timer: undefined,
    polling: false,
    stopped: false,
  };
  const isStopped = (): boolean => watch.stopped;
  const stopWatching = (): void => {
    watch.stopped = true;
    if (watch.timer !== undefined) clearInterval(watch.timer);
    watch.timer = undefined;
  };

  // Heartbeat writes are serialized, so the final one (with `endedAt`) is always the last to land.
  const beats = { queue: Promise.resolve(), lastAt: Math.floor(clock()), finalWritten: false };
  const enqueueBeat = (beat: RunHeartbeat): Promise<void> => {
    beats.queue = beats.queue
      .then(() => writeRunHeartbeat(ports.artifacts, leaseId, beat))
      .catch(() => undefined);
    return beats.queue;
  };
  const writeFinalBeat = (): Promise<void> => {
    if (beats.finalWritten) return beats.queue;
    beats.finalWritten = true;
    return enqueueBeat({ v: 1, beatAt: beats.lastAt, endedAt: Math.floor(clock()) });
  };

  // A transport that closes on its own (the agent went away) only stops the watcher: the final
  // heartbeat is written by `close()` or by the end sequence, which a host awaits before it exits.
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => {
      stopWatching();
      resolve();
    };
  });
  await server.connect(transport);

  // The one evaluation path: the standalone `verify-outcome` command reaches the same function. This run
  // hands it the vault, connector, teardown steps and fence it already serves with. A `user_confirm`
  // prompt is bounded by the manifest's approval timeout.
  const verifyOutcome = async (): Promise<Lease> => {
    const result = await evaluateVerifier({
      verifier: verified.manifest.job.verifier,
      leaseStore,
      receiptStore,
      leaseId,
      clock,
      teardownSteps,
      teardownFence,
      adapter,
      signal: AbortSignal.timeout(verified.manifest.approvals.timeout_seconds * 1000),
      read: { bindings: profile.bindings, vault, connector },
    });
    return result.lease;
  };

  const endedBox: { resolve: (value: LeaseEnded) => void } = { resolve: () => undefined };
  const ended = new Promise<LeaseEnded>((resolve) => {
    endedBox.resolve = resolve;
  });

  /** Tears an ended lease down under the fence, or leaves it to the driver that holds it (D-06, D-09). Never throws. */
  const tearDownEnded = async (current: Lease): Promise<Pick<LeaseEnded, "teardown" | "blockedResources">> => {
    if (isLanded(current.state)) return { teardown: "other_driver" };
    try {
      const finished = await runTeardown(
        {
          leaseStore,
          receiptStore,
          leaseId,
          steps: teardownSteps,
          signingKey: privateKey,
          ...(ports.telemetry === undefined ? {} : { telemetry: ports.telemetry }),
          fence: teardownFence,
          credentialCheck: {
            expected: expectedResources,
            missing: () => missingCredentials(ports, leaseId, expectedResources),
          },
        },
        clock(),
      );
      if (finished.state === "cleaned_up") return { teardown: "cleaned_up" };
      if (finished.state === "cleanup_incomplete") return { teardown: "cleanup_incomplete" };
      return { teardown: "not_run" };
    } catch (error) {
      if (error instanceof TeardownFencedError) return { teardown: "other_driver" };
      if (error instanceof TeardownBlockedError) {
        return { teardown: "blocked", blockedResources: error.resources };
      }
      return { teardown: "not_run" };
    }
  };

  const reasonOf = async (current: Lease | undefined): Promise<LeaseEndReason> => {
    if (current === undefined) return "unavailable";
    switch (current.state) {
      case "expired":
      case "revoked":
      case "completed":
      case "failed":
        return current.state;
      case "tearing_down":
      case "cleaned_up":
      case "cleanup_incomplete":
        return await reasonFromChain(receiptStore);
      default:
        return "unavailable";
    }
  };

  /** The end sequence, run once: stop the timer, find the reason, tear down, final heartbeat, resolve, close (D-06 to D-08). */
  const endRun = async (current: Lease | undefined): Promise<void> => {
    stopWatching();
    let reason: LeaseEndReason = "unavailable";
    try {
      reason = await reasonOf(current);
    } catch {
      // the reason stays unavailable; the teardown below does not depend on it
    }
    const outcome = current === undefined ? { teardown: "not_run" as const } : await tearDownEnded(current);
    await writeFinalBeat();
    endedBox.resolve({
      reason,
      teardown: outcome.teardown,
      ...(outcome.blockedResources === undefined ? {} : { blockedResources: outcome.blockedResources }),
    });
    try {
      await server.close();
    } catch {
      // the transport was already closing
    }
  };

  const runTick = async (): Promise<void> => {
    const at = Math.floor(clock());
    if (at - beats.lastAt >= RUN_HEARTBEAT_INTERVAL_SECONDS) {
      beats.lastAt = at;
      void enqueueBeat({ v: 1, beatAt: at });
    }

    let current = await leaseStore.load(leaseId);
    if (isStopped()) return;
    if (current?.state === "active" && isPastExpiry(current, clock())) {
      // Nothing else applies the clock's expire event; this run settles it by its own clock (D-07).
      await settleExpired(ports, leaseId);
      current = await leaseStore.load(leaseId);
    }
    if (current?.state === "active" && probeIntervalSeconds > 0 && clock() >= probe.nextAt) {
      const outcome = await probeLeaseGrants(ports, leaseId, {
        vault,
        resources: expectedResources,
        timeoutMs: DEFAULT_OAUTH_TIMEOUT_MS,
        checkLiveRun: false,
      });
      const after = clock();
      switch (outcome.kind) {
        case "ok":
        case "not_probeable":
          probe.failures = 0;
          probe.nextAt = after + probeIntervalSeconds;
          break;
        case "transient":
          probe.failures += 1;
          probe.nextAt =
            after +
            Math.max(outcome.retryAfterSeconds ?? 0, probeBackoffSeconds(probe.failures, probeIntervalSeconds));
          break;
        case "revoked":
        case "skipped":
          break;
      }
      current = outcome.kind === "revoked" ? outcome.lease : await leaseStore.load(leaseId);
    }
    if (isStopped()) return;
    if (current?.state !== "active") await endRun(current);
  };

  const tick = async (): Promise<void> => {
    if (watch.polling || watch.stopped) return;
    watch.polling = true;
    try {
      await runTick();
    } catch {
      // A failed tick (store offline, provider unreachable) is retried on the next one; it never leaves the timer.
    } finally {
      watch.polling = false;
    }
  };

  // First heartbeat before the run reports itself serving, then the one watcher interval.
  await enqueueBeat({ v: 1, beatAt: beats.lastAt });
  const watchMs =
    options.leaseWatchMs !== undefined && options.leaseWatchMs > 0 ? options.leaseWatchMs : DEFAULT_LEASE_WATCH_MS;
  const handle = setInterval(() => {
    void tick();
  }, watchMs);
  // A browser timer has no unref; a Node one must not keep the process alive on its own.
  (handle as unknown as { unref?: () => void }).unref?.();
  watch.timer = handle;

  const close = async (): Promise<void> => {
    stopWatching();
    await writeFinalBeat();
    await server.close();
  };

  return { closed, close, ended, verifyOutcome };
}
