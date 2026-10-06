/**
 * Supervisor timing configuration (Phase 9 D-22). Later plans add fields; the
 * three here are the capped exponential backoff for retrying a
 * `cleanup_incomplete` lease. Every value is a whole number: seconds for the
 * two durations, a count for the cap.
 */
export interface SupervisorConfig {
  /** Wait in seconds after the first failed teardown pass; doubles with each further failed pass. */
  readonly retryBaseSeconds: number;
  /** The longest single wait in seconds. */
  readonly retryMaxSeconds: number;
  /** How many retries follow the first failed pass before the lease is marked stuck. */
  readonly retryCap: number;
}

/** 60 s doubling to at most 3600 s, 8 retries: about three hours in total (D-22). */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  retryBaseSeconds: 60,
  retryMaxSeconds: 3600,
  retryCap: 8,
};
