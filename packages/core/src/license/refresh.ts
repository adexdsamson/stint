/**
 * Bounded license refresh: a pure per-call decision under an injected clock,
 * with an issued-expiry clamp that can never outlive the lease (D-12, LIC-03).
 *
 * `needsRefresh` holds no state between calls -- it is re-evaluated fresh
 * every time it's invoked, exactly like `reduce`/`evaluatePolicy` elsewhere in
 * `@stint/core` (RESEARCH.md Pattern 4). `clampedLicenseExpiry` accepts and
 * returns ONLY epoch-seconds numbers; it imports no type from `paseto` and
 * never touches a `Date` or an RFC 3339 string -- that conversion is isolated
 * entirely inside `issue.ts`/`verify.ts` (RESEARCH.md Pitfall 1).
 */

/** The runtime-configuration default license TTL in seconds (300s, D-13) -- never carried in the manifest. */
export const DEFAULT_LICENSE_TTL_SECONDS = 300;

/**
 * Returns `true` once `now` has reached `refreshBeforeSeconds` before `exp`.
 * Pure and stateless: callers must re-invoke this every time they need the
 * decision -- there is no cached "still valid" boolean to reuse across calls
 * (D-12, PITFALLS.md Pitfall 9).
 */
export function needsRefresh(exp: number, now: number, refreshBeforeSeconds: number): boolean {
  return now >= exp - refreshBeforeSeconds;
}

/**
 * Computes the next license expiry as `min(now + defaultTtlSeconds,
 * leaseExpiresAt)`, and returns `null` once `now >= leaseExpiresAt` -- refresh
 * is refused rather than issuing an expiry the lease has already passed
 * (LIC-03). No refreshed token can ever outlive the lease.
 */
export function clampedLicenseExpiry(
  now: number,
  defaultTtlSeconds: number,
  leaseExpiresAt: number,
): number | null {
  if (now >= leaseExpiresAt) return null;
  return Math.min(now + defaultTtlSeconds, leaseExpiresAt);
}
