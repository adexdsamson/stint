/**
 * `refreshAccessToken` -- the OAuth 2.1 refresh-token grant + revocation
 * classification hot path (D-03, D-04, D-09, PRXY-08). This module owns
 * every `oauth4webapi` call site the vault needs: it sends the RFC 8707
 * `resource` indicator via `additionalParameters` (the library's documented
 * mechanism -- there is no first-class `resource` option), and classifies
 * every failure per D-09/D-17's status-guarded revocation signal: only a
 * definitive 4xx counts as `provider_revoked` (`invalid_grant` with a status
 * in 400-499 other than 429, or a 401 `invalid_token` in either shape
 * `oauth4webapi` surfaces); every other failure (5xx, 429, network, timeout,
 * a 401 `invalid_client`, an unexpected body) is a `transient_error` that
 * feeds the LIFE-07 error threshold instead, never revokes. A transient
 * failure carries the provider's `Retry-After`, clamped, when it sent one.
 *
 * Every refresh and every RFC 7009 revocation request carries an
 * `AbortSignal` (15 s by default, `DEFAULT_OAUTH_TIMEOUT_MS`), so a hung
 * provider yields `transient_error` / `failed` instead of holding a lease
 * lock forever.
 *
 * `allowInsecureRequests` is NEVER hardcoded here -- it is threaded through
 * an explicit `opts.allowInsecureRequests` flag the caller must opt into
 * (the mock-AS test harness in `../testing.ts` is the only caller that ever
 * sets it `true`; a real production `OAuthClient` wired in a later phase
 * simply omits it, leaving `oauth4webapi`'s HTTPS-only default guard
 * intact).
 */

import * as oauth from "oauth4webapi";

/**
 * An OAuth grant the vault can refresh and revoke (D-04). `kind` is optional:
 * a value with no `kind` is an OAuth grant, so every pre-existing call site
 * and fixture keeps compiling unchanged (D-05). `expiry` is an absolute
 * epoch-seconds value compared against the injected `now` -- per-call expiry,
 * no cached "still valid" boolean (locked upstream).
 */
export interface OAuthSeededCredential {
  readonly kind?: "oauth";
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute epoch-seconds expiry of `accessToken`. */
  readonly expiry: number;
  readonly tokenEndpoint: string;
  /** The RFC 8707 `resource` indicator sent on every refresh request for this credential. */
  readonly resourceIndicator: string;
  /** Non-secret per-credential client config: the OAuth `client_id` (fallback `stint`). */
  readonly clientId?: string;
  /** Non-secret per-credential client config: the RFC 7009 revocation endpoint, when the server has one. */
  readonly revocationEndpoint?: string;
}

/**
 * A static API key held for one resource. It never expires, is never refreshed and has no provider the vault can revoke at.
 *
 * `origin` is the ONE origin this key may be sent to (Phase 10 D-B, CRED-02). It
 * is bound at seed time (a credentials-file entry, then the run profile's
 * `providerOrigins`, then the runtime's closed provider table) and read back
 * from the store at call time by the connector, never from the call's inputs.
 * It is `https:` or loopback `http:` only; a stored key with no usable origin
 * is treated as absent, so the vault fails closed instead of guessing.
 */
export interface ApiKeySeededCredential {
  readonly kind: "api_key";
  readonly key: string;
  readonly origin: string;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True iff `value` parses as a URL that is `https:` or plain `http:` to a
 * loopback host (localhost, 127.0.0.1, [::1]). The one rule every API-key
 * origin intake applies, the same shape `parseEndpoints` enforces.
 */
export function isSecureOrLoopbackOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
}

/** What the vault holds for one `leaseId:resource`: an OAuth grant (absent `kind`) or an API key. */
export type SeededCredential = OAuthSeededCredential | ApiKeySeededCredential;

/** Narrows a {@link SeededCredential} to the API key member. */
export function isApiKeyCredential(c: SeededCredential): c is ApiKeySeededCredential {
  return c.kind === "api_key";
}

/** The result of one refresh attempt -- classified per D-09, never swallowed as a bare boolean. */
export type RefreshResult =
  | { readonly kind: "ok"; readonly accessToken: string; readonly refreshToken?: string; readonly expiry: number }
  | { readonly kind: "provider_revoked" }
  | {
      readonly kind: "transient_error";
      readonly cause: unknown;
      /** The provider's `Retry-After` in whole seconds, clamped to 0..3600, when the response carried a usable one. */
      readonly retryAfterSeconds?: number;
    };

/**
 * The `oauth4webapi` wiring a refresh call needs: discovered/constructed
 * Authorization Server metadata, this proxy's OAuth `Client` identity, and
 * its client-authentication method. Bundled together so `resolveAccessToken`
 * (credential-vault.ts) only has to thread ONE value through, not three.
 */
export interface OAuthClient {
  readonly as: oauth.AuthorizationServer;
  readonly client: oauth.Client;
  readonly clientAuth: oauth.ClientAuth;
}

/** Picks the {@link OAuthClient} one credential refreshes and revokes with. */
export type OAuthClientResolver = (resource: string, credential: OAuthSeededCredential) => OAuthClient;

/**
 * Builds the {@link OAuthClient} for one credential from its own non-secret
 * fields: the issuer is the token endpoint's origin, `revocation_endpoint` is
 * set only when the credential carries one (its absence is the structural
 * signal for `discarded_revocation_unsupported`), the client id is `clientId`
 * or the fallback `stint`, and the client authenticates as an RFC 6749 public
 * client by `client_id` only.
 */
export function oauthClientFromCredential(credential: OAuthSeededCredential): OAuthClient {
  return {
    as: {
      issuer: new URL(credential.tokenEndpoint).origin,
      token_endpoint: credential.tokenEndpoint,
      ...(credential.revocationEndpoint === undefined ? {} : { revocation_endpoint: credential.revocationEndpoint }),
    },
    client: { client_id: credential.clientId ?? "stint" },
    clientAuth: (_as, client, body) => {
      body.set("client_id", client.client_id);
    },
  };
}

/** Per-call options for {@link refreshAccessToken}. */
export interface RefreshOptions {
  /**
   * Set `true` ONLY against a loopback test authorization server (the mock
   * AS harness in `../testing.ts`). Never set this against a production
   * endpoint -- `oauth4webapi` defaults to HTTPS-only as a hard security
   * guard, and this flag is the documented, explicit opt-out of that guard.
   */
  readonly allowInsecureRequests?: boolean;
  /**
   * An outer abort signal (a supervisor's shutdown, for example). It is
   * combined with the request timeout, never replacing it: a request can still
   * not outlive `timeoutMs`.
   */
  readonly signal?: AbortSignal;
  /** Request timeout in milliseconds. Defaults to {@link DEFAULT_OAUTH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The default per-request timeout for every refresh and revocation call (T-09-24). */
export const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;

/** The largest `Retry-After` honoured, in seconds; a larger value is clamped (T-09-27). */
const MAX_RETRY_AFTER_SECONDS = 3600;

/** The request `signal` for one OAuth call: the timeout, joined with the caller's own signal when one is given. */
function requestSignal(opts: RefreshOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS);
  return opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
}

/**
 * D-17's status-guarded revocation classifier, shared by the call path and
 * the idle-lease probe so they always agree. Provider-side revocation is
 * exactly one of:
 *
 * - an `oauth.ResponseBodyError` whose `.error` is `"invalid_grant"` and whose
 *   HTTP status is 400-499 other than 429;
 * - an `oauth.ResponseBodyError` whose `.error` is `"invalid_token"` with
 *   status 401 (JSON body shape);
 * - an `oauth.WWWAuthenticateChallengeError` with status 401 whose parsed
 *   challenges carry an `error` parameter equal to `"invalid_token"`.
 *
 * Everything else is a `transient_error`: a 5xx or 429 (whatever its body
 * says), a network failure, a timeout, a 401 `invalid_client`, a 200 with an
 * error body, any other OAuth error code. A single blip must never revoke a
 * lease. A single definitive 4xx `invalid_grant` does, including the
 * documented provider false positives (inactivity, IP restriction): ending a
 * lease is the fail-closed direction.
 */
export function classifyTokenError(err: unknown): "provider_revoked" | "transient_error" {
  if (err instanceof oauth.ResponseBodyError) {
    if (err.error === "invalid_grant" && err.status >= 400 && err.status <= 499 && err.status !== 429) {
      return "provider_revoked";
    }
    if (err.error === "invalid_token" && err.status === 401) {
      return "provider_revoked";
    }
    return "transient_error";
  }
  if (err instanceof oauth.WWWAuthenticateChallengeError && err.status === 401) {
    const challenged = err.cause.some((challenge) => challenge.parameters.error === "invalid_token");
    return challenged ? "provider_revoked" : "transient_error";
  }
  return "transient_error";
}

function isResponse(v: unknown): v is Response {
  return typeof Response !== "undefined" && v instanceof Response;
}

/**
 * Extracts the provider's `Retry-After` from a thrown token-endpoint error, in
 * whole seconds clamped to 0..3600. A `Response` is looked up on `err.response`
 * and on `err.cause`. A whole number is delta-seconds; a value with letters is
 * parsed as an HTTP date and measured against `nowSeconds` (the injected
 * clock, epoch seconds). Returns `undefined` when there is no header, or it is
 * negative or unparseable. It reads only the header: no body or error text
 * leaves this function.
 */
export function retryAfterFromError(err: unknown, nowSeconds: number): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { response?: unknown }).response ?? (err as { cause?: unknown }).cause;
  if (!isResponse(candidate)) return undefined;
  const raw = candidate.headers.get("retry-after")?.trim();
  if (raw === undefined || raw === "") return undefined;

  let seconds: number;
  if (/^-?\d+$/.test(raw)) {
    seconds = Number(raw);
    if (seconds < 0) return undefined;
  } else if (/[A-Za-z]/.test(raw)) {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil(at / 1000 - nowSeconds);
  } else {
    return undefined;
  }
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS);
}

/**
 * The honest, closed tri-state a single RFC 7009 revoke attempt collapses to
 * (D-20, TEAR-02, Pitfall 5). `"revoked"` is the ceiling of what the runtime
 * can ever claim from a bare 2xx -- it is NEVER upgraded to a stronger
 * "confirmed" claim, because RFC 7009 explicitly permits an AS to return 2xx
 * for a token it does not recognize or has already invalidated by other
 * means. `"failed"` carries `cause` for local diagnostics only -- callers
 * (the vault, teardown step 1) must never let `cause` reach a receipt or the
 * agent (Pitfall 8 scrub discipline); it is collapsed to the closed
 * `"failed"` string before it crosses that boundary.
 */
export type RevokeResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "discarded_revocation_unsupported" }
  | { readonly kind: "failed"; readonly cause: unknown };

/**
 * Attempts one RFC 7009 revocation of `refreshToken` against
 * `oauthClient`'s authorization server. Support is determined STRUCTURALLY,
 * BEFORE any network call (D-20): if `oauthClient.as.revocation_endpoint` is
 * absent from the discovered/constructed AS metadata, this function returns
 * `{ kind: "discarded_revocation_unsupported" }` immediately and makes no
 * HTTP request at all -- the absence of the endpoint is the signal, never a
 * response code. When a `revocation_endpoint` IS present, a 2xx response
 * (per RFC 7009 Section 2.2, an AS returns 200 even for a token it does not
 * recognize) maps to `{ kind: "revoked" }` and nothing stronger; any thrown
 * error (network failure, non-2xx, malformed response) is caught and
 * collapsed to `{ kind: "failed", cause: err }` -- a raw `oauth4webapi`
 * exception never escapes this function unclassified.
 */
export async function revokeCredential(
  oauthClient: OAuthClient,
  refreshToken: string,
  opts: RefreshOptions = {},
): Promise<RevokeResult> {
  if (oauthClient.as.revocation_endpoint === undefined) {
    return { kind: "discarded_revocation_unsupported" };
  }

  try {
    const requestOptions: oauth.RevocationRequestOptions = { signal: requestSignal(opts) };
    if (opts.allowInsecureRequests === true) {
      // Deliberate, opt-in-only: see `refreshAccessToken`'s identical guard
      // above -- only the loopback mock-AS test harness ever sets this.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      requestOptions[oauth.allowInsecureRequests] = true;
    }

    const response = await oauth.revocationRequest(
      oauthClient.as,
      oauthClient.client,
      oauthClient.clientAuth,
      refreshToken,
      requestOptions,
    );
    await oauth.processRevocationResponse(response);
    return { kind: "revoked" };
  } catch (err) {
    return { kind: "failed", cause: err };
  }
}

/**
 * Performs one OAuth 2.1 refresh-token grant against `credential`'s
 * authorization server, carrying the RFC 8707 `resource` indicator, and
 * returns a classified {@link RefreshResult}. `now` (the injected clock, not
 * `Date.now()`) is what the new token's absolute `expiry` is computed
 * against, from the response's `expires_in` (defaulting to 3600 seconds per
 * RFC 6749 Section 4.2.2 guidance when the AS omits it).
 */
export async function refreshAccessToken(
  oauthClient: OAuthClient,
  credential: OAuthSeededCredential,
  now: number,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  try {
    const requestOptions: oauth.TokenEndpointRequestOptions = {
      additionalParameters: { resource: credential.resourceIndicator },
      signal: requestSignal(opts),
    };
    if (opts.allowInsecureRequests === true) {
      // Deliberate, opt-in-only: `opts.allowInsecureRequests` is never set by
      // production wiring, only by the loopback mock-AS test harness
      // (`../testing.ts`).
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      requestOptions[oauth.allowInsecureRequests] = true;
    }

    const response = await oauth.refreshTokenGrantRequest(
      oauthClient.as,
      oauthClient.client,
      oauthClient.clientAuth,
      credential.refreshToken,
      requestOptions,
    );
    const tokens = await oauth.processRefreshTokenResponse(oauthClient.as, oauthClient.client, response);
    const expiresIn = tokens.expires_in ?? 3600;

    return {
      kind: "ok",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiry: now + expiresIn,
    };
  } catch (err) {
    if (classifyTokenError(err) === "provider_revoked") {
      return { kind: "provider_revoked" };
    }
    const retryAfterSeconds = retryAfterFromError(err, now);
    return retryAfterSeconds === undefined
      ? { kind: "transient_error", cause: err }
      : { kind: "transient_error", cause: err, retryAfterSeconds };
  }
}
