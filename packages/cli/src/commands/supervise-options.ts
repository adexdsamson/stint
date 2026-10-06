/**
 * Flag parsing for `stint-cli supervise` (Phase 9 D-15, D-22, T-09-16). Every
 * value is a plain non-negative decimal integer; the durations stay within the
 * largest value a platform timer accepts, in seconds, and the cap within a
 * small count. `--probe-interval` alone accepts 0, which disables probing. A bad value is a usage error with fixed text naming the flag.
 */

import { DEFAULT_SUPERVISOR_CONFIG } from "@stint/runtime";
import type { SupervisorConfig } from "@stint/runtime";

import { CliError, EXIT_CODES } from "../exit.js";
import type { SuperviseOpts } from "./supervise.js";

/** 2147483 s is the largest whole number of seconds whose millisecond value fits a 32-bit timer. */
const MAX_SECONDS = 2_147_483;
const MAX_CAP = 1000;

const BASE_MESSAGE = `--retry-base must be a whole number of seconds from 1 to ${String(MAX_SECONDS)}.`;
const MAX_MESSAGE = `--retry-max must be a whole number of seconds from 1 to ${String(MAX_SECONDS)}.`;
const CAP_MESSAGE = `--retry-cap must be a whole number of retries from 1 to ${String(MAX_CAP)}.`;
const PROBE_MESSAGE = `--probe-interval must be a whole number of seconds from 0 to ${String(MAX_SECONDS)} (0 disables probing).`;
const ORDER_MESSAGE = "--retry-max must not be smaller than --retry-base.";

/** The value as a whole number in `[min, max]`, or a usage error with `message`. An absent flag yields `fallback`. */
function wholeNumber(value: string | undefined, max: number, fallback: number, message: string, min = 1): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new CliError(EXIT_CODES.usage, message);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new CliError(EXIT_CODES.usage, message);
  return parsed;
}

/** Validates `--retry-base`, `--retry-max`, `--retry-cap` and `--probe-interval`; absent flags take the defaults. */
export function parseSupervisorConfig(opts: SuperviseOpts): SupervisorConfig {
  const retryBaseSeconds = wholeNumber(
    opts.retryBase,
    MAX_SECONDS,
    DEFAULT_SUPERVISOR_CONFIG.retryBaseSeconds,
    BASE_MESSAGE,
  );
  const retryMaxSeconds = wholeNumber(
    opts.retryMax,
    MAX_SECONDS,
    DEFAULT_SUPERVISOR_CONFIG.retryMaxSeconds,
    MAX_MESSAGE,
  );
  const retryCap = wholeNumber(opts.retryCap, MAX_CAP, DEFAULT_SUPERVISOR_CONFIG.retryCap, CAP_MESSAGE);
  const probeIntervalSeconds = wholeNumber(
    opts.probeInterval,
    MAX_SECONDS,
    DEFAULT_SUPERVISOR_CONFIG.probeIntervalSeconds,
    PROBE_MESSAGE,
    0,
  );
  if (retryMaxSeconds < retryBaseSeconds) throw new CliError(EXIT_CODES.usage, ORDER_MESSAGE);
  return { ...DEFAULT_SUPERVISOR_CONFIG, retryBaseSeconds, retryMaxSeconds, retryCap, probeIntervalSeconds };
}
