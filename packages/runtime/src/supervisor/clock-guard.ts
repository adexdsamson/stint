/**
 * Forward clock jump detection (Phase 9 SUP-06, D-19). The wall clock and a
 * monotonic clock are sampled together at each sweep. In normal running the two
 * advance by the same amount between samples; when the wall clock has moved
 * further than the monotonic clock, the system time was set forward (NTP, a
 * manual change, a virtual machine resume), and every lease would look expired.
 */

/** One paired reading: the wall clock in epoch seconds and a monotonic clock in milliseconds. */
export interface ClockSample {
  readonly wall: number;
  readonly monoMs: number;
}

/**
 * How many seconds the wall clock advanced beyond the monotonic clock between
 * two samples. Negative when the wall clock went backwards or advanced less.
 */
export function forwardJumpSeconds(prev: ClockSample, cur: ClockSample): number {
  return cur.wall - prev.wall - (cur.monoMs - prev.monoMs) / 1000;
}
