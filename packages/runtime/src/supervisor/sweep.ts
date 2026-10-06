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
 * Retry (SUP-02, D-01, D-22): a `cleanup_incomplete` lease is retried when its
 * backoff, derived from the verified receipt chain alone, has run out. After
 * the retry cap the lease is marked stuck with a receipted reason and left
 * `cleanup_incomplete`, visible, until the user runs `stint-cli cleanup`.
 *
 * Stuck (SUP-02, D-02, D-03, D-04): when retrying cannot help, the lease gets
 * one verified `teardown_stuck` receipt with a reason and stays where it is,
 * visible, until the user fixes the cause. The reasons are missing
 * credentials (`credentials_unavailable`, marked at once), a failed
 * revocation (`revocation_failed`, never retried), a stored manifest that no
 * longer verifies (`manifest_invalid`) and an exhausted retry budget. A
 * stuck lease is only re-checked cheaply and adds no receipt: missing
 * credentials through `missingCredentials()`, the manifest through
 * `resolveTeardown`. When the cause is fixed the lease is torn down or
 * retried normally. Each new marking tells the host once through `notify`;
 * the first sweep of each supervisor run (one `SweepState`) announces every
 * lease that is already stuck, once, so an operator who starts a new
 * supervisor sees what remains live. There is no way to abandon a stuck lease.
 *
 * Probe (SUP-04, D-14 to D-18): an idle `active` lease is probed on a schedule
 * (default every 900 s after its last call or grant). The probe is a real
 * refresh under the lease lock; only a definitive provider revocation ends the
 * lease, which is then torn down in the same sweep. A 5xx, a 429, a network
 * error or a timeout never ends a lease: the sweep only records telemetry and
 * waits longer (capped exponential backoff, `Retry-After` honoured). A lease a
 * live `run` serves (fresh `run_heartbeat`) is never probed.
 *
 * Isolation (SUP-05, D-23): each lease runs in its own try/catch. A lease another
 * driver holds (`TeardownFencedError`) adds no event. A record the store could
 * not read, and a failure the host's `isStoreCorrupt` predicate calls
 * corruption (a torn receipt chain, envelope or binding), is reported as
 * `corrupt_record` by id only; any other failure is a `lease_error` carrying
 * only the lease id; and the sweep continues with the next lease. Nothing here
 * writes, renames or deletes a corrupt file. A report repeats only when the
 * record's fingerprint changes or after `corruptRepeatSeconds`, so a persistent
 * fault does not flood a log, and a lease that is processed cleanly forgets it.
 *
 * Stop (SUP-07, D-21): with `signal` set, an aborted signal is checked before
 * each lease and passed into every teardown pass, which stops between steps
 * and releases its fence. The sweep then returns `aborted: true` and starts no
 * further lease; the lease a pass left `tearing_down` is resumed by the next
 * driver from its receipts.
 *
 * Clock (SUP-06, D-19): with `control` and `monotonicMs` set, each sweep samples the wall and
 * the monotonic clock. When the wall clock moved more than `clockJumpThresholdSeconds` beyond the
 * monotonic clock since the previous sweep, a persisted pause marker is written and the sweep stops
 * settling expiry: a lease past `expiresAt` stays as it is, with no receipt, until the operator
 * confirms the clock. Retries, the teardown of ended leases and grant probes carry on. The
 * confirmation carries the pause's random id and is honoured only while that pause exists; an
 * unreadable marker counts as a pause. A run with no baseline (a new `SweepState`) cannot detect a
 * jump but honours a pause already on disk.
 */

import { safeEmit } from "@stint/core";
import type { Lease, LeaseScanEntry, LifecycleEvent, TeardownStuckReason } from "@stint/core";
import {
  TeardownBlockedError,
  TeardownFencedError,
  createCredentialVault,
  oauthClientFromCredential,
} from "@stint/proxy";
import type { TeardownStep } from "@stint/proxy";
import type { ReceiptEntry } from "@stint/spec";

import { expectedCredentialResources } from "../custody.js";
import { RuntimeError } from "../errors.js";
import { allowInsecureForClient } from "../loopback.js";
import { loadLeaseManifest } from "../manifest.js";
import type { RuntimePorts } from "../ports.js";
import { resolveTeardown } from "../resolve-teardown.js";
import type { ResolvedTeardown } from "../resolve-teardown.js";
import { settleExpired } from "../settle-expired.js";
import { forwardJumpSeconds } from "./clock-guard.js";
import type { ClockSample } from "./clock-guard.js";
import { DEFAULT_SUPERVISOR_CONFIG } from "./config.js";
import type { SupervisorConfig } from "./config.js";
import type { SupervisorControl } from "./control.js";
import { isRunLive } from "./heartbeat.js";
import { probeBackoffSeconds, probeLeaseGrants } from "./probe.js";
import { deriveRetryState } from "./retry-state.js";
import { markStuck } from "./stuck.js";

/** One thing the sweep did or found. Closed union; carries no secret, token, record content or error text. */
export type SweepEvent =
  | { readonly kind: "expired"; readonly leaseId: string }
  | { readonly kind: "torn_down"; readonly leaseId: string; readonly lease: Lease }
  | {
      readonly kind: "corrupt_record";
      readonly leaseId: string;
      readonly unreadable: "corrupt" | "io_error";
    }
  | { readonly kind: "lease_error"; readonly leaseId: string }
  /** The provider revoked the grant of an idle lease; the lease is torn down next, in the same sweep. */
  | { readonly kind: "grant_revoked"; readonly leaseId: string }
  | { readonly kind: "retried"; readonly leaseId: string; readonly attempt: number; readonly lease: Lease }
  | {
      readonly kind: "stuck";
      readonly leaseId: string;
      readonly reason: TeardownStuckReason;
      readonly attempts: number;
      /** True for a re-announcement of a lease that was already stuck, with no new receipt. */
      readonly repeat: boolean;
    }
  /** Lease expiry is paused after a forward clock jump; `repeat` is true for a pause found on disk by a run that did not write it. */
  | { readonly kind: "clock_paused"; readonly jumpSeconds: number; readonly repeat: boolean }
  /** The operator confirmed the clock; lease expiry resumes in this sweep. */
  | { readonly kind: "clock_confirmed" }
  /** The pause marker exists but cannot be read; lease expiry stays paused until it is fixed. Once per run. */
  | { readonly kind: "clock_marker_unreadable" };

/**
 * What one supervisor run has already told the operator. Pass the same state
 * to every sweep of a loop; a new run (a `--once` invocation, a restarted
 * supervisor) starts with a fresh one and so announces every stuck lease once.
 */
export interface SweepState {
  /** Lease ids announced as stuck in this run; cleared for a lease once it is torn down or retried. */
  readonly announcedStuck: Set<string>;
  /** The probe schedule of each idle active lease, kept for the life of this run (D-15, D-17). */
  readonly probes: Map<string, ProbeSchedule>;
  /** What was last reported for each lease that is corrupt or failing, for deduplication (D-23). */
  readonly reports: Map<string, ReportMemory>;
  /** The clock baseline and what was announced about the pause markers in this run (SUP-06, D-19). */
  readonly clock: ClockState;
}

/** The clock guard's memory for one supervisor run. */
export interface ClockState {
  /** The wall and monotonic reading of the previous sweep; `undefined` until a sweep takes one. Not moved while paused. */
  baseline: ClockSample | undefined;
  /** True once this run has announced the current pause. */
  pauseAnnounced: boolean;
  /** True once this run has announced an unreadable pause marker. */
  unreadableAnnounced: boolean;
}

/** The last `corrupt_record` or `lease_error` report made for a lease in this run. */
export interface ReportMemory {
  /** The store's file fingerprint for an unreadable record, or a fixed marker for a failure inside the lease's data. */
  readonly fingerprint: string;
  /** Epoch seconds. */
  readonly reportedAt: number;
}

/** When a lease is next probed and how many probes in a row failed transiently. */
export interface ProbeSchedule {
  /** Epoch seconds. */
  nextProbeAt: number;
  failures: number;
}

export function createSweepState(): SweepState {
  return {
    announcedStuck: new Set<string>(),
    probes: new Map<string, ProbeSchedule>(),
    reports: new Map<string, ReportMemory>(),
    clock: { baseline: undefined, pauseAnnounced: false, unreadableAnnounced: false },
  };
}

/** The later of the grant time and the newest `call` receipt: the lease's last activity (D-16). */
function lastActivityOf(lease: Lease, chain: readonly ReceiptEntry[]): number {
  let latest = lease.grantedAt;
  for (const entry of chain) {
    if (entry.type !== "call") continue;
    const ts: unknown = entry.ts;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest;
}

const STUCK_REASONS: ReadonlySet<string> = new Set<TeardownStuckReason>([
  "credentials_unavailable",
  "retries_exhausted",
  "revocation_failed",
  "manifest_invalid",
]);

function isStuckReason(value: string): value is TeardownStuckReason {
  return STUCK_REASONS.has(value);
}

function isManifestInvalid(error: unknown): boolean {
  return error instanceof RuntimeError && error.code === "manifest_invalid";
}

/** The default corruption test: the runtime's own `store_corrupt` error. A host adds its own store's error. */
function isRuntimeStoreCorrupt(error: unknown): boolean {
  return error instanceof RuntimeError && error.code === "store_corrupt";
}

// Fingerprints for a failure found inside a lease's data (there is no file fingerprint at the port level).
const DATA_CORRUPT = "data:store_corrupt";
const DATA_ERROR = "data:lease_error";

export interface SweepReport {
  readonly events: readonly SweepEvent[];
  /** How many store entries the sweep looked at (readable or not). */
  readonly scanned: number;
  /** True when the stop signal was aborted before the sweep finished; no lease was started after that. */
  readonly aborted: boolean;
}

export interface RunSweepOptions {
  /** Lets a host (or a test) wrap the five default teardown steps. */
  readonly decorateSteps?: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
  /** Fence lifetime in seconds for the teardown passes this sweep runs. */
  readonly fenceTtlSeconds?: number;
  /** Retry timing; defaults to `DEFAULT_SUPERVISOR_CONFIG`. */
  readonly config?: SupervisorConfig;
  /**
   * Tells the sweep which thrown errors mean a lease's stored data is corrupt (D-23). The runtime cannot
   * import a host's store error, so the host supplies the test. Defaults to a `RuntimeError` with code
   * `store_corrupt`. A predicate that throws counts as "not corrupt".
   */
  readonly isStoreCorrupt?: (error: unknown) => boolean;
  /** What this run already announced; a fresh state when absent, so every stuck lease is announced once. */
  readonly state?: SweepState;
  /** Told once per new stuck marking, never for a re-announcement. A failing callback never changes an outcome. */
  readonly notify?: (event: LifecycleEvent) => Promise<void>;
  /** Called for each event as it happens and awaited before the sweep moves on. A failing callback never stops the sweep. */
  readonly onEvent?: (event: SweepEvent) => void | Promise<void>;
  /** A graceful-stop request (D-21): checked before each lease and passed into each teardown pass, which stops between steps. */
  readonly signal?: AbortSignal;
  /** Where the clock pause and its confirmation are kept (SUP-06, D-19). Without it expiry is never paused. */
  readonly control?: SupervisorControl;
  /** A monotonic millisecond clock. Without it no jump is ever detected, but a pause already persisted is honoured. */
  readonly monotonicMs?: () => number;
  /** A fresh random id for a pause marker; defaults to `globalThis.crypto.randomUUID()`. */
  readonly randomId?: () => string;
}

/** What the sweep does with a lease in a given state. Closed so a new state is a compile error. */
type Route = "settle_then_teardown" | "teardown" | "retry" | "nothing";

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
      return "retry";
    case "cleaned_up":
    case "declined":
    case "proposed":
      return "nothing";
  }
}

function isLanded(state: Lease["state"]): boolean {
  return state === "cleaned_up" || state === "cleanup_incomplete";
}

/**
 * The clock guard (SUP-06, D-19), run at the start of a sweep. Resolves `true` when lease expiry must not
 * be settled in this sweep: a pause marker exists that no matching confirmation has cleared, the marker
 * cannot be read (fail closed), or a jump was just detected. A host without `control` is never paused.
 * It never throws: a marker that cannot be written leaves expiry paused for this sweep and is tried again
 * at the next one, because the baseline does not move.
 */
async function clockGate(
  ports: RuntimePorts,
  options: RunSweepOptions,
  config: SupervisorConfig,
  state: SweepState,
  emit: (event: SweepEvent) => Promise<void>,
): Promise<boolean> {
  const control = options.control;
  if (control === undefined) return false;
  const clock = state.clock;

  let pause: Awaited<ReturnType<SupervisorControl["readPause"]>>;
  try {
    pause = await control.readPause();
    clock.unreadableAnnounced = false;
  } catch {
    if (!clock.unreadableAnnounced) {
      clock.unreadableAnnounced = true;
      await emit({ kind: "clock_marker_unreadable" });
    }
    return true;
  }

  const sample = (): ClockSample | undefined => {
    const monoMs = options.monotonicMs;
    if (monoMs === undefined) return undefined;
    const reading = { wall: ports.clock(), monoMs: monoMs() };
    return Number.isFinite(reading.wall) && Number.isFinite(reading.monoMs) ? reading : undefined;
  };

  if (pause !== undefined) {
    let confirmedId: string | undefined;
    try {
      confirmedId = (await control.readConfirm())?.id;
    } catch {
      // An unreadable confirmation confirms nothing.
    }
    if (confirmedId === pause.id) {
      try {
        await control.clearPause();
      } catch {
        // Still paused; the matching confirmation is still there for the next sweep.
        return true;
      }
      try {
        await control.clearConfirm();
      } catch {
        // A leftover confirmation carries the old id and can never match a later pause.
      }
      clock.baseline = sample();
      clock.pauseAnnounced = false;
      await emit({ kind: "clock_confirmed" });
      return false;
    }
    if (!clock.pauseAnnounced) {
      clock.pauseAnnounced = true;
      safeEmit(ports.telemetry, { name: "supervisor.clock_paused", jumpSeconds: pause.jumpSeconds });
      await emit({ kind: "clock_paused", jumpSeconds: pause.jumpSeconds, repeat: true });
    }
    return true;
  }

  const current = sample();
  if (current === undefined) return false;
  const previous = clock.baseline;
  if (previous === undefined) {
    clock.baseline = current;
    return false;
  }
  const jump = forwardJumpSeconds(previous, current);
  if (!(jump > config.clockJumpThresholdSeconds)) {
    clock.baseline = current;
    return false;
  }

  const jumpSeconds = Math.floor(jump);
  const id = (options.randomId ?? ((): string => globalThis.crypto.randomUUID()))();
  try {
    // A confirmation already on disk predates this pause; clear it before the pause exists so it cannot linger.
    await control.clearConfirm().catch(() => undefined);
    await control.writePause({ v: 1, id, detectedAt: Math.floor(current.wall), jumpSeconds });
  } catch {
    // Not persisted: nothing is settled now and the next sweep measures the same jump again.
    return true;
  }
  clock.pauseAnnounced = true;
  safeEmit(ports.telemetry, { name: "supervisor.clock_paused", jumpSeconds });
  await emit({ kind: "clock_paused", jumpSeconds, repeat: false });
  return true;
}

/**
 * Runs one sweep over every lease in `ports.leases`.
 *
 * @experimental The runtime surface is not yet stable.
 */
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

  // Read through a function: a bare property read after an await is narrowed by control-flow analysis.
  const stopRequested = (): boolean => options.signal?.aborted === true;
  if (stopRequested()) return { events, scanned: 0, aborted: true };

  const config = options.config ?? DEFAULT_SUPERVISOR_CONFIG;
  const state = options.state ?? createSweepState();
  const entries: readonly LeaseScanEntry[] = await ports.leases.scan();

  // Clock guard (SUP-06, D-19): decided once per sweep, before any lease is looked at.
  const expiryPaused = await clockGate(ports, options, config, state, emit);

  const corruptTest = options.isStoreCorrupt ?? isRuntimeStoreCorrupt;
  const looksCorrupt = (error: unknown): boolean => {
    try {
      return corruptTest(error);
    } catch {
      return false;
    }
  };

  /**
   * True when a report for `leaseId` should be made now: it is new, its fingerprint changed, or the quiet
   * period has run out. Records the report when it is made, so the next sweep deduplicates against it.
   */
  const shouldReport = (leaseId: string, fingerprint: string, previous: ReportMemory | undefined): boolean => {
    const at = ports.clock();
    if (
      previous !== undefined &&
      previous.fingerprint === fingerprint &&
      at - previous.reportedAt < config.corruptRepeatSeconds
    ) {
      state.reports.set(leaseId, previous);
      return false;
    }
    state.reports.set(leaseId, { fingerprint, reportedAt: at });
    return true;
  };

  /** Reports a corrupt record or a failure of one lease, deduplicated; never carries contents or error text. */
  const reportFailure = async (
    leaseId: string,
    failure: unknown,
    previous: ReportMemory | undefined,
  ): Promise<void> => {
    if (looksCorrupt(failure)) {
      if (!shouldReport(leaseId, DATA_CORRUPT, previous)) return;
      safeEmit(ports.telemetry, { name: "supervisor.corrupt_record", leaseId });
      await emit({ kind: "corrupt_record", leaseId, unreadable: "corrupt" });
      return;
    }
    if (!shouldReport(leaseId, DATA_ERROR, previous)) return;
    await emit({ kind: "lease_error", leaseId });
  };

  /** Tells the host a lease is stuck; a failing host never changes an outcome. */
  const notifyHost = async (leaseId: string, reason: TeardownStuckReason): Promise<void> => {
    try {
      await options.notify?.({ type: "teardown_stuck", leaseId, at: ports.clock(), reason });
    } catch {
      // a host that cannot be told must not stop the sweep
    }
  };

  /** Writes the verified stuck marker (once) and, when it wrote, announces it: event, telemetry and host. */
  const markAndAnnounce = async (
    leaseId: string,
    reason: TeardownStuckReason,
    attempts: number,
  ): Promise<void> => {
    const wrote = await markStuck(ports, leaseId, { reason, attempts }, ports.clock());
    if (!wrote) return;
    state.announcedStuck.add(leaseId);
    safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "stuck" });
    await emit({ kind: "stuck", leaseId, reason, attempts, repeat: false });
    await notifyHost(leaseId, reason);
  };

  /** Failed teardown passes since the last stuck marker, from the verified chain. */
  const failedPassesOf = async (leaseId: string): Promise<number> =>
    deriveRetryState(await ports.receipts(leaseId).load("verified"), config, ports.clock()).failedPasses;

  /**
   * Probes an idle active lease when its schedule says so (SUP-04). Returns the
   * lease the provider revocation moved to `tearing_down`, or `undefined` when
   * nothing ended it. A provider failure never throws out of here; a transient
   * result only moves the schedule.
   */
  const probeIdle = async (leaseId: string, lease: Lease): Promise<Lease | undefined> => {
    const interval = config.probeIntervalSeconds;
    if (interval <= 0) return undefined;
    const telemetry = (result: "ok" | "revoked" | "transient" | "not_probeable" | "skipped", next: number): void => {
      safeEmit(ports.telemetry, {
        name: "supervisor.probe",
        leaseId,
        result,
        nextProbeInSeconds: Math.max(0, Math.round(next)),
      });
    };

    let schedule = state.probes.get(leaseId);
    if (schedule === undefined) {
      // First sight in this run: due one interval after the last call or the grant.
      const first = await ports.receipts(leaseId).load("verified");
      schedule = { nextProbeAt: lastActivityOf(lease, first) + interval, failures: 0 };
      state.probes.set(leaseId, schedule);
    }
    if (ports.clock() < schedule.nextProbeAt) return undefined;

    // Cheap check first; probeLeaseGrants checks again inside the lease transaction (D-18).
    if (await isRunLive(ports.artifacts, leaseId, ports.clock())) {
      telemetry("skipped", 0);
      return undefined;
    }

    // A call since the schedule was made means the lease is not idle yet.
    const chain = await ports.receipts(leaseId).load("verified");
    if (deriveRetryState(chain, config, ports.clock()).stuck !== undefined) return undefined;
    const idleUntil = lastActivityOf(lease, chain) + interval;
    if (ports.clock() < idleUntil) {
      schedule.nextProbeAt = idleUntil;
      return undefined;
    }

    let resources: readonly string[];
    try {
      const { manifest } = await loadLeaseManifest(ports, leaseId);
      resources = await expectedCredentialResources(ports, leaseId, manifest);
    } catch (error) {
      if (!isManifestInvalid(error)) throw error;
      // Nothing to probe against and nothing to receipt: look again in a full interval.
      schedule.nextProbeAt = ports.clock() + interval;
      return undefined;
    }

    // A vault built just now from the stores never holds a refresh token another run or supervisor rotated (Pitfall 4).
    const vault = createCredentialVault((_resource, credential) => oauthClientFromCredential(credential), ports.clock, {
      secrets: ports.secrets,
      allowInsecureRequests: allowInsecureForClient,
    });
    const outcome = await probeLeaseGrants(ports, leaseId, {
      vault,
      resources,
      timeoutMs: config.probeTimeoutMs,
      checkLiveRun: true,
    });

    const at = ports.clock();
    switch (outcome.kind) {
      case "revoked":
        state.probes.delete(leaseId);
        telemetry("revoked", 0);
        safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "grant_revoked" });
        await emit({ kind: "grant_revoked", leaseId });
        return outcome.lease;
      case "ok":
      case "not_probeable":
        schedule.failures = 0;
        schedule.nextProbeAt = at + interval;
        telemetry(outcome.kind, interval);
        return undefined;
      case "transient": {
        schedule.failures += 1;
        const wait = Math.max(outcome.retryAfterSeconds ?? 0, probeBackoffSeconds(schedule.failures, interval));
        schedule.nextProbeAt = at + wait;
        telemetry("transient", wait);
        return undefined;
      }
      case "skipped":
        if (outcome.reason === "not_active") state.probes.delete(leaseId);
        telemetry("skipped", 0);
        return undefined;
    }
  };

  /** Reports an already stuck lease once per run, with no receipt and no host notice. */
  const reannounce = async (leaseId: string, reason: TeardownStuckReason, attempts: number): Promise<void> => {
    if (state.announcedStuck.has(leaseId)) return;
    state.announcedStuck.add(leaseId);
    await emit({ kind: "stuck", leaseId, reason, attempts, repeat: true });
  };

  // A lease no longer in the store has nothing left to deduplicate.
  const present = new Set(entries.map((entry) => entry.id));
  for (const id of [...state.reports.keys()]) {
    if (!present.has(id)) state.reports.delete(id);
  }

  for (const entry of entries) {
    if (stopRequested()) break;
    // What was reported last time; a lease processed cleanly this time forgets it (D-23).
    const previous = state.reports.get(entry.id);
    if ("unreadable" in entry) {
      if (shouldReport(entry.id, `file:${entry.fingerprint}`, previous)) {
        safeEmit(ports.telemetry, { name: "supervisor.corrupt_record", leaseId: entry.id });
        await emit({ kind: "corrupt_record", leaseId: entry.id, unreadable: entry.unreadable });
      }
      continue;
    }
    state.reports.delete(entry.id);
    const leaseId = entry.id;
    try {
      let lease = entry.lease;
      let action = route(lease, ports.clock());
      if (lease.state !== "active") state.probes.delete(leaseId);
      if (action === "settle_then_teardown" && expiryPaused) {
        // A lease only the clock says is past its expiry: leave it exactly as it is until the operator confirms.
        safeEmit(ports.telemetry, { name: "supervisor.expiry_paused", leaseId });
        continue;
      }
      if (action === "settle_then_teardown") {
        const settled = await settleExpired(ports, leaseId);
        lease = settled.lease;
        if (settled.settled) {
          safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "expired" });
          await emit({ kind: "expired", leaseId });
        }
        action = route(lease, ports.clock());
      }
      if (action === "nothing" && lease.state === "active") {
        // An idle, unexpired lease: ask the provider whether its grant is alive (SUP-04).
        const ended = await probeIdle(leaseId, lease);
        if (ended === undefined) continue;
        lease = ended;
        action = route(lease, ports.clock());
      }
      if (action !== "retry" && action !== "teardown") continue;

      const resolveInput = {
        leaseId,
        ...(options.decorateSteps === undefined ? {} : { decorateSteps: options.decorateSteps }),
        ...(options.fenceTtlSeconds === undefined ? {} : { fenceTtlSeconds: options.fenceTtlSeconds }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      let resolved: ResolvedTeardown | undefined;

      const derived = deriveRetryState(await ports.receipts(leaseId).load("verified"), config, ports.clock());
      const stuck = derived.stuck;
      if (stuck !== undefined) {
        // Reason text no known version of the supervisor writes: leave the lease alone and name nothing.
        if (!isStuckReason(stuck.reason)) continue;
        if (stuck.reason === "credentials_unavailable") {
          // The cheap re-check: no teardown pass, so nothing is appended while the credentials stay missing (D-02).
          resolved = await resolveTeardown(ports, resolveInput);
          if ((await resolved.missingCredentials()).length > 0) {
            await reannounce(leaseId, stuck.reason, stuck.attempts);
            continue;
          }
        } else if (stuck.reason === "manifest_invalid") {
          try {
            resolved = await resolveTeardown(ports, resolveInput);
          } catch (error) {
            if (!isManifestInvalid(error)) throw error;
            await reannounce(leaseId, stuck.reason, stuck.attempts);
            continue;
          }
        } else if (action === "retry") {
          // revocation_failed and retries_exhausted: only a user cleanup moves the lease (D-01, D-03).
          // A lease an interrupted pass left tearing_down is still resumed below.
          await reannounce(leaseId, stuck.reason, stuck.attempts);
          continue;
        }
        // The cause is fixed (credentials back, manifest verifies again): the lease is torn down or
        // retried at once, not at the end of a backoff the stuck marker reset.
      } else if (action === "retry") {
        // A revocation that failed is attempted once and never repeated (D-23): retrying cannot help.
        if (lease.teardownProgress?.revoke_oauth === "failed") {
          await markAndAnnounce(leaseId, "revocation_failed", derived.failedPasses);
          continue;
        }
        if (derived.exhausted) {
          await markAndAnnounce(leaseId, "retries_exhausted", derived.failedPasses);
          continue;
        }
        if (!derived.due) continue;
      }

      resolved ??= await resolveTeardown(ports, resolveInput);

      if (action === "retry") {
        const finished = await resolved.retry("runtime", ports.clock());
        state.announcedStuck.delete(leaseId);
        safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "retried" });
        await emit({ kind: "retried", leaseId, attempt: derived.failedPasses, lease: finished });

        if (finished.state === "cleanup_incomplete") {
          const after = deriveRetryState(await ports.receipts(leaseId).load("verified"), config, ports.clock());
          if (after.stuck === undefined && after.exhausted) {
            await markAndAnnounce(leaseId, "retries_exhausted", after.failedPasses);
          }
        }
        continue;
      }

      const landedBefore = isLanded(lease.state);
      const finished = await resolved.run(ports.clock());
      state.announcedStuck.delete(leaseId);
      if (!landedBefore && isLanded(finished.state)) {
        safeEmit(ports.telemetry, { name: "supervisor.action", leaseId, action: "torn_down" });
        await emit({ kind: "torn_down", leaseId, lease: finished });
      }
    } catch (error) {
      if (error instanceof TeardownFencedError) continue;
      let failure: unknown = error;
      try {
        if (error instanceof TeardownBlockedError) {
          await markAndAnnounce(leaseId, "credentials_unavailable", await failedPassesOf(leaseId));
          continue;
        }
        if (isManifestInvalid(error)) {
          await markAndAnnounce(leaseId, "manifest_invalid", await failedPassesOf(leaseId));
          continue;
        }
      } catch (markError) {
        // The marker could not be written (its own read may hit the corruption); report that failure below.
        failure = markError;
      }
      await reportFailure(leaseId, failure, previous);
    }
  }

  return { events, scanned: entries.length, aborted: stopRequested() };
}
