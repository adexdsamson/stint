/**
 * Supervisor timing configuration (Phase 9 D-22, D-15). Later plans add fields.
 * The first three are the capped exponential backoff for retrying a
 * `cleanup_incomplete` lease; the last two schedule the grant probe of an idle
 * lease; `corruptRepeatSeconds` is the quiet period before an unchanged corrupt
 * record is reported again. Every value is a whole number: seconds or
 * milliseconds for a duration, a count for the cap.
 */
export interface SupervisorConfig {
  /** Wait in seconds after the first failed teardown pass; doubles with each further failed pass. */
  readonly retryBaseSeconds: number;
  /** The longest single wait in seconds. */
  readonly retryMaxSeconds: number;
  /** How many retries follow the first failed pass before the lease is marked stuck. */
  readonly retryCap: number;
  /** Seconds between provider probes of an idle active lease's grant; 0 disables probing (D-15). */
  readonly probeIntervalSeconds: number;
  /** Timeout of one probe request to the token endpoint, in milliseconds. */
  readonly probeTimeoutMs: number;
  /** Seconds before an unchanged corrupt record, or a persistent lease failure, is reported again in one supervisor run (D-23). */
  readonly corruptRepeatSeconds: number;
  /** How far in seconds the wall clock may advance beyond the monotonic clock between two sweeps before expiry is paused (SUP-06, D-19). */
  readonly clockJumpThresholdSeconds: number;
}

/**
 * Retry: 60 s doubling to at most 3600 s, 8 retries, about three hours in total
 * (D-22). Probe: every 900 s per idle lease with a 15 s request timeout (D-15).
 * Corrupt report: repeated at most once a day while the record is unchanged (D-23).
 * Clock jump: a forward jump of more than 3600 s pauses expiry until confirmed (D-19).
 */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  retryBaseSeconds: 60,
  retryMaxSeconds: 3600,
  retryCap: 8,
  probeIntervalSeconds: 900,
  probeTimeoutMs: 15_000,
  corruptRepeatSeconds: 86_400,
  clockJumpThresholdSeconds: 3600,
};
