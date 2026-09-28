/**
 * `createCredentialVault` -- the D-02/D-04 secretless token custody
 * boundary + PRXY-08 single-flight refresh guard. Mirrors
 * `@stint/core/license/held-license.ts`'s module-private-storage + single-
 * accessor custody discipline: raw tokens live in a `Map` that is closed
 * over inside this factory (never exported, never assignable to any public
 * property), and `resolveAccessToken` is the ONLY path that reads one out.
 *
 * The single-flight guard (T-04-05-RR) reuses the EXACT per-id promise-chain
 * idiom `@stint/core/testing`'s `createInMemoryLeaseStore` implements
 * (`runSerialized`), keyed `leaseId:resource` here instead of `leaseId` --
 * never a second global lock. Chaining (not a shared dedup promise) is
 * sufficient to prove single-flight: every queued call re-checks the
 * record's expiry against `now` before doing any network work, so only the
 * FIRST call in a same-key chain ever finds the token still expired and
 * calls `refreshAccessToken`; every call behind it in the chain runs after
 * that refresh has already landed and short-circuits on the fresh token
 * with zero additional token-endpoint hits.
 */

import { refreshAccessToken, revokeCredential } from "./oauth-client.js";
import type { OAuthClient, RefreshOptions, RevokeResult, SeededCredential } from "./oauth-client.js";

/** The vault's public surface (D-04). No method returns the raw store; only `resolveAccessToken` reads a token out. */
export interface CredentialVault {
  /** Seeds (or replaces) the credential stored for `leaseId:resource`. */
  seedCredential(leaseId: string, resource: string, seeded: SeededCredential): void;
  /**
   * Returns a valid access token for `leaseId:resource`, refreshing under
   * the per-credential single-flight guard if the stored token's `expiry`
   * is not strictly greater than `now`. Rejects with {@link CredentialRefreshError}
   * (`kind: "provider_revoked" | "transient_error"`) if a refresh was
   * required and did not succeed -- the 04-07 revocation wiring is the
   * intended consumer of `.kind`. Never swallows a failed refresh as a
   * stale "success."
   */
  resolveAccessToken(leaseId: string, resource: string, now: number): Promise<string>;
  /**
   * Teardown step 1 (D-22, D-23): for every credential currently seeded
   * under `leaseId`, calls {@link revokeCredential} internally with the
   * refresh token this vault holds (the token never leaves the vault) and
   * then DELETES that entry from the vault -- regardless of the resulting
   * `RevokeResult` (revoked, unsupported, or failed). The runtime always
   * discards its own copy, even on a failed or unsupported revoke, so it
   * never retains a usable credential post-teardown. Returns the honest
   * per-credential outcome so the caller (teardown step 1) can receipt each
   * one individually. A lease with no seeded credentials returns an empty
   * array and makes no revoke call -- the caller maps that to
   * `not_applicable` (D-33, hosted-only lease).
   */
  revokeAndDiscardLeaseCredentials(
    leaseId: string,
    now: number,
  ): Promise<ReadonlyArray<{ readonly resource: string; readonly result: RevokeResult }>>;
  /**
   * Deletes every credential seeded under `leaseId` WITHOUT attempting any
   * revoke call -- used by teardown step 4 ("delete cached data", a later
   * plan) once step 1 has already made its terminal, one-time revoke
   * attempt (D-23). Idempotent: deleting an already-discarded lease's
   * credentials is a no-op.
   */
  discardLeaseCredentials(leaseId: string): void;
}

/** Every credential key currently seeded for `leaseId`, resolved back to its bare `resource` (the inverse of {@link keyFor}). The trailing colon in the prefix check prevents a lease id that is a string-prefix of another (e.g. "lease-1" vs "lease-10") from matching the wrong lease's entries. */
function leaseCredentialEntries(
  credentials: Map<string, SeededCredential>,
  leaseId: string,
): ReadonlyArray<{ readonly key: string; readonly resource: string; readonly credential: SeededCredential }> {
  const prefix = `${leaseId}:`;
  const entries: Array<{ key: string; resource: string; credential: SeededCredential }> = [];
  for (const [key, credential] of credentials) {
    if (key.startsWith(prefix)) {
      entries.push({ key, resource: key.slice(prefix.length), credential });
    }
  }
  return entries;
}

/**
 * Thrown by {@link CredentialVault.resolveAccessToken} when a required
 * refresh does not succeed. `kind` carries D-09's classification verbatim
 * (`refreshAccessToken`'s `RefreshResult.kind`, minus `"ok"`) so a caller
 * (04-07's revocation wiring) can branch on it without re-deriving the
 * signal itself.
 */
export class CredentialRefreshError extends Error {
  readonly kind: "provider_revoked" | "transient_error";
  override readonly cause?: unknown;

  constructor(key: string, kind: "provider_revoked" | "transient_error", cause?: unknown) {
    super(`@stint/proxy: credential refresh for "${key}" failed (${kind}).`);
    this.name = "CredentialRefreshError";
    this.kind = kind;
    this.cause = cause;
  }
}

function keyFor(leaseId: string, resource: string): string {
  return `${leaseId}:${resource}`;
}

/**
 * Constructs a `CredentialVault` backed by `oauthClient` (the discovered
 * Authorization Server metadata + this proxy's `Client`/`ClientAuth`
 * identity) and `clock` (the injectable `now` source -- no internal timers,
 * per-call expiry only, matching the locked-upstream "no cached still-valid
 * boolean" discipline).
 */
export function createCredentialVault(
  oauthClient: OAuthClient,
  clock: () => number,
  refreshOpts: RefreshOptions = {},
): CredentialVault {
  const credentials = new Map<string, SeededCredential>();
  const tails = new Map<string, Promise<unknown>>();

  function runSingleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previousTail = tails.get(key) ?? Promise.resolve();
    // Swallow a prior failure so one rejected refresh never wedges the
    // chain for later, unrelated resolves on the same key.
    const next = previousTail.catch(() => undefined).then(work);
    tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  return {
    seedCredential(leaseId: string, resource: string, seeded: SeededCredential): void {
      credentials.set(keyFor(leaseId, resource), { ...seeded });
    },

    resolveAccessToken(leaseId: string, resource: string, now: number): Promise<string> {
      const key = keyFor(leaseId, resource);
      const record = credentials.get(key);
      if (record === undefined) {
        return Promise.reject(new Error(`@stint/proxy: no credential seeded for "${key}".`));
      }

      // Per-call expiry against the injected clock -- pure comparison, no
      // cached "still valid" boolean, no timer.
      if (record.expiry > now) {
        return Promise.resolve(record.accessToken);
      }

      return runSingleFlight(key, async () => {
        // Re-read: a prior call in this same-key chain may have already
        // refreshed the credential while this call was queued.
        const current = credentials.get(key);
        if (current === undefined) {
          throw new Error(`@stint/proxy: no credential seeded for "${key}".`);
        }
        if (current.expiry > now) {
          return current.accessToken;
        }

        const result = await refreshAccessToken(oauthClient, current, now, refreshOpts);

        if (result.kind === "ok") {
          const updated: SeededCredential = {
            ...current,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken ?? current.refreshToken,
            expiry: result.expiry,
          };
          credentials.set(key, updated);
          return updated.accessToken;
        }

        if (result.kind === "provider_revoked") {
          throw new CredentialRefreshError(key, "provider_revoked");
        }
        throw new CredentialRefreshError(key, "transient_error", result.cause);
      });
    },

    async revokeAndDiscardLeaseCredentials(
      leaseId: string,
      // Accepted for interface symmetry with `resolveAccessToken`'s injected
      // clock discipline and future auditability -- the revoke call itself
      // carries no expiry/timing logic of its own, so it is unused here.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _now: number,
    ): Promise<ReadonlyArray<{ readonly resource: string; readonly result: RevokeResult }>> {
      const entries = leaseCredentialEntries(credentials, leaseId);
      const outcomes: Array<{ resource: string; result: RevokeResult }> = [];

      for (const { key, resource, credential } of entries) {
        const result = await revokeCredential(oauthClient, credential.refreshToken, refreshOpts);
        // Always discard the runtime's own copy (D-22) -- regardless of
        // revoked, discarded_revocation_unsupported, or failed. This is not
        // gated on `result.kind`: even a failed revoke attempt permanently
        // ends this credential's custody in the vault.
        credentials.delete(key);
        outcomes.push({ resource, result });
      }

      return outcomes;
    },

    discardLeaseCredentials(leaseId: string): void {
      for (const { key } of leaseCredentialEntries(credentials, leaseId)) {
        credentials.delete(key);
      }
    },
  };
}
