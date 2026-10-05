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

import { credentialSecretKey, leaseSecretPrefix } from "@stint/core";
import type { SecretStore } from "@stint/core";

import { isApiKeyCredential, refreshAccessToken, revokeCredential } from "./oauth-client.js";
import type {
  OAuthClient,
  OAuthClientResolver,
  OAuthSeededCredential,
  RevokeResult,
  SeededCredential,
} from "./oauth-client.js";

/**
 * Options for {@link createCredentialVault}. `allowInsecureRequests` is a
 * superset of the old `RefreshOptions` flag: a boolean applies to every
 * credential (as before); a function is evaluated per resolved client so plain
 * http can be allowed for one credential's server and not another's.
 *
 * `secrets` makes the vault durable: a credential missing from memory is
 * loaded through from the store, a refreshed credential (including a rotated
 * refresh token) is written through, and discard removes the stored copies.
 * Without it the vault is in-memory only, exactly as before.
 */
export interface CredentialVaultOptions {
  readonly allowInsecureRequests?: boolean | ((client: OAuthClient) => boolean);
  readonly secrets?: SecretStore;
}

const STORED_CREDENTIAL_VERSION = 1;

/**
 * Serializes a credential for a `SecretStore` value. The result holds the
 * secret tokens: it belongs only in a store and must never be logged or
 * receipted.
 */
export function serializeStoredCredential(credential: SeededCredential): string {
  return JSON.stringify({ v: STORED_CREDENTIAL_VERSION, credential });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

/**
 * Parses a value written by {@link serializeStoredCredential}. Strict: version
 * 1 and either the api_key shape or the full OAuth shape; anything else
 * (corrupt, edited, wrong version) returns `undefined` and is treated as
 * absent. It never throws and never echoes the stored contents.
 */
export function parseStoredCredential(raw: string): SeededCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== STORED_CREDENTIAL_VERSION || !isRecord(parsed.credential)) {
    return undefined;
  }
  const c = parsed.credential;

  if (c.kind === "api_key") {
    return typeof c.key === "string" && c.key !== "" ? { kind: "api_key", key: c.key } : undefined;
  }
  if (c.kind !== undefined && c.kind !== "oauth") return undefined;

  if (
    typeof c.accessToken !== "string" ||
    typeof c.refreshToken !== "string" ||
    typeof c.expiry !== "number" ||
    !Number.isFinite(c.expiry) ||
    typeof c.tokenEndpoint !== "string" ||
    !URL.canParse(c.tokenEndpoint) ||
    typeof c.resourceIndicator !== "string" ||
    !isOptionalString(c.clientId) ||
    !isOptionalString(c.revocationEndpoint) ||
    (c.revocationEndpoint !== undefined && !URL.canParse(c.revocationEndpoint))
  ) {
    return undefined;
  }
  return {
    ...(c.kind === "oauth" ? { kind: "oauth" as const } : {}),
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiry: c.expiry,
    tokenEndpoint: c.tokenEndpoint,
    resourceIndicator: c.resourceIndicator,
    ...(c.clientId === undefined ? {} : { clientId: c.clientId }),
    ...(c.revocationEndpoint === undefined ? {} : { revocationEndpoint: c.revocationEndpoint }),
  };
}

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
    expectedResources?: readonly string[],
  ): Promise<ReadonlyArray<{ readonly resource: string; readonly result: RevokeResult }>>;
  /**
   * Deletes every credential seeded under `leaseId` WITHOUT attempting any
   * revoke call -- used by teardown step 4 ("delete cached data", a later
   * plan) once step 1 has already made its terminal, one-time revoke
   * attempt (D-23). Idempotent: deleting an already-discarded lease's
   * credentials is a no-op. Returns a promise only when the vault was built
   * with a durable store to clear.
   */
  discardLeaseCredentials(leaseId: string): void | Promise<void>;
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
 * Constructs a `CredentialVault` backed by `client` (either one
 * `OAuthClient` used for every credential, or an {@link OAuthClientResolver}
 * that picks the client per credential: the discovered Authorization Server
 * metadata + this proxy's `Client`/`ClientAuth` identity) and `clock` (the
 * injectable `now` source -- no internal timers, per-call expiry only,
 * matching the locked-upstream "no cached still-valid boolean" discipline).
 */
export function createCredentialVault(
  client: OAuthClient | OAuthClientResolver,
  clock: () => number,
  opts: CredentialVaultOptions = {},
): CredentialVault {
  const credentials = new Map<string, SeededCredential>();
  const tails = new Map<string, Promise<unknown>>();
  const resolveClient: OAuthClientResolver = typeof client === "function" ? client : () => client;

  /** The OAuth client for one credential, plus the insecure-transport flag computed for that client. */
  function clientFor(
    resource: string,
    credential: OAuthSeededCredential,
  ): { readonly oauthClient: OAuthClient; readonly requestOpts: { readonly allowInsecureRequests: boolean } } {
    const oauthClient = resolveClient(resource, credential);
    const flag = opts.allowInsecureRequests;
    const allowInsecureRequests = typeof flag === "function" ? flag(oauthClient) : flag === true;
    return { oauthClient, requestOpts: { allowInsecureRequests } };
  }

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


  const secrets = opts.secrets;
  /**
   * Keys whose in-memory credential is newer than the store's copy because a
   * write-through failed. Retried at the start of the next resolve, inside the
   * single-flight chain, before any token is returned.
   */
  const dirty = new Set<string>();
  /**
   * Credentials this vault revoked or discarded. Load-through never brings one
   * back from the store, so a failed store delete cannot resurrect a revoked
   * grant inside this process. Reseeding a key lifts its entry.
   */
  const discardedKeys = new Set<string>();
  const discardedLeases = new Set<string>();

  function persist(leaseId: string, resource: string, key: string, credential: SeededCredential): Promise<void> {
    if (secrets === undefined) return Promise.resolve();
    // A rejected put surfaces as a fixed transient_error: the error never
    // carries the stored value, only the `leaseId:resource` key.
    return Promise.resolve()
      .then(() => secrets.put(credentialSecretKey(leaseId, resource), serializeStoredCredential(credential)))
      .then(
        () => {
          dirty.delete(key);
        },
        () => {
          dirty.add(key);
          throw new CredentialRefreshError(key, "transient_error");
        },
      );
  }

  /**
   * Loads one credential through from the store into memory. An absent key, a
   * store error or a value that does not parse is "absent": nothing is thrown
   * and no stored content is echoed. If another caller seeded or refreshed the
   * key while the read was in flight, that newer in-memory record wins.
   */
  async function loadThrough(leaseId: string, resource: string, key: string): Promise<SeededCredential | undefined> {
    const existing = credentials.get(key);
    if (existing !== undefined || secrets === undefined) return existing;
    if (discardedKeys.has(key) || discardedLeases.has(leaseId)) return undefined;
    let loaded: SeededCredential | undefined;
    try {
      const raw = await secrets.get(credentialSecretKey(leaseId, resource));
      loaded = raw === undefined ? undefined : parseStoredCredential(raw);
    } catch {
      loaded = undefined;
    }
    const raced = credentials.get(key);
    if (raced !== undefined) return raced;
    if (loaded !== undefined) credentials.set(key, loaded);
    return loaded;
  }

  return {
    seedCredential(leaseId: string, resource: string, seeded: SeededCredential): void {
      const key = keyFor(leaseId, resource);
      discardedKeys.delete(key);
      credentials.set(key, { ...seeded });
    },

    async resolveAccessToken(leaseId: string, resource: string, now: number): Promise<string> {
      const key = keyFor(leaseId, resource);
      const record = credentials.get(key) ?? (await loadThrough(leaseId, resource, key));
      if (record === undefined) {
        throw new Error(`@stint/proxy: no credential seeded for "${key}".`);
      }

      // An API key never expires and never enters the refresh path.
      if (isApiKeyCredential(record)) {
        return record.key;
      }

      // Per-call expiry against the injected clock -- pure comparison, no
      // cached "still valid" boolean, no timer. A dirty key is never answered
      // from here: its pending write-through must land first.
      if (record.expiry > now && !dirty.has(key)) {
        return record.accessToken;
      }

      return runSingleFlight(key, async () => {
        // Re-read: a prior call in this same-key chain may have already
        // refreshed the credential while this call was queued.
        const current = credentials.get(key);
        if (current === undefined) {
          throw new Error(`@stint/proxy: no credential seeded for "${key}".`);
        }
        if (isApiKeyCredential(current)) {
          return current.key;
        }

        // Retry a pending write-through before anything else: the provider
        // already consumed the old refresh token, so the new one (held in
        // memory) must reach the store before this call can succeed.
        if (dirty.has(key)) {
          await persist(leaseId, resource, key, current);
        }

        if (current.expiry > now) {
          return current.accessToken;
        }

        const { oauthClient, requestOpts } = clientFor(resource, current);
        const result = await refreshAccessToken(oauthClient, current, now, requestOpts);

        if (result.kind === "ok") {
          const updated: OAuthSeededCredential = {
            ...current,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken ?? current.refreshToken,
            expiry: result.expiry,
          };
          // Memory first: the old refresh token is spent, so the new one must
          // survive in process even when persisting it fails.
          credentials.set(key, updated);
          await persist(leaseId, resource, key, updated);
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
      _now: number,
      expectedResources?: readonly string[],
    ): Promise<ReadonlyArray<{ readonly resource: string; readonly result: RevokeResult }>> {
      // A later process (cleanup, a supervisor) holds nothing in memory: pull
      // every expected resource missing from memory through from the store.
      for (const resource of expectedResources ?? []) {
        await loadThrough(leaseId, resource, keyFor(leaseId, resource));
      }

      const entries = leaseCredentialEntries(credentials, leaseId);
      const outcomes: Array<{ resource: string; result: RevokeResult }> = [];

      for (const { key, resource, credential } of entries) {
        let result: RevokeResult;
        if (isApiKeyCredential(credential)) {
          // No provider to tell and no network call: the same honest path an
          // unrevocable OAuth grant takes (D-14).
          result = { kind: "discarded_revocation_unsupported" };
        } else {
          const { oauthClient, requestOpts } = clientFor(resource, credential);
          result = await revokeCredential(oauthClient, credential.refreshToken, requestOpts);
        }
        // Always discard the runtime's own copy (D-22) -- regardless of
        // revoked, discarded_revocation_unsupported, or failed. This is not
        // gated on `result.kind`: even a failed revoke attempt permanently
        // ends this credential's custody in the vault.
        credentials.delete(key);
        dirty.delete(key);
        discardedKeys.add(key);
        if (secrets !== undefined) {
          try {
            await secrets.delete(credentialSecretKey(leaseId, resource));
          } catch {
            // Swallowed on purpose: the outcome above is what the provider
            // said. The step-4 purge with read-back is the authority that
            // reports a secret left behind (D-13).
          }
        }
        outcomes.push({ resource, result });
      }

      return outcomes;
    },

    discardLeaseCredentials(leaseId: string): void | Promise<void> {
      for (const { key } of leaseCredentialEntries(credentials, leaseId)) {
        credentials.delete(key);
        dirty.delete(key);
        discardedKeys.add(key);
      }
      if (secrets === undefined) return undefined;
      discardedLeases.add(leaseId);
      // A deletePrefix rejection propagates: the caller must know a stored
      // copy may remain.
      return Promise.resolve().then(async () => {
        await secrets.deletePrefix(leaseSecretPrefix(leaseId));
      });
    },
  };
}
