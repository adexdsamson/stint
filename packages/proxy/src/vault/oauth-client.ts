/**
 * `refreshAccessToken` -- the OAuth 2.1 refresh-token grant + revocation
 * classification hot path (D-03, D-04, D-09, PRXY-08). This module owns
 * every `oauth4webapi` call site the vault needs: it sends the RFC 8707
 * `resource` indicator via `additionalParameters` (the library's documented
 * mechanism -- there is no first-class `resource` option), and classifies
 * every failure per D-09's narrow revocation signal: ONLY
 * `oauth.ResponseBodyError` with `.error === 'invalid_grant'` counts as
 * `provider_revoked`; every other failure (5xx, network, non-auth 4xx) is a
 * `transient_error` that feeds the LIFE-07 error threshold instead, never
 * revokes.
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
 * The narrow "load/seed credential" seam (D-04): both this phase's tests and
 * the future interactive-acquisition flow (CLI/example, later phases)
 * produce values of this shape to hand to the vault. `expiry` is an
 * absolute epoch-seconds value compared against the injected `now` --
 * per-call expiry, no cached "still valid" boolean (locked upstream).
 */
export interface SeededCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute epoch-seconds expiry of `accessToken`. */
  readonly expiry: number;
  readonly tokenEndpoint: string;
  /** The RFC 8707 `resource` indicator sent on every refresh request for this credential. */
  readonly resourceIndicator: string;
}

/** The result of one refresh attempt -- classified per D-09, never swallowed as a bare boolean. */
export type RefreshResult =
  | { readonly kind: "ok"; readonly accessToken: string; readonly refreshToken?: string; readonly expiry: number }
  | { readonly kind: "provider_revoked" }
  | { readonly kind: "transient_error"; readonly cause: unknown };

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

/** Per-call options for {@link refreshAccessToken}. */
export interface RefreshOptions {
  /**
   * Set `true` ONLY against a loopback test authorization server (the mock
   * AS harness in `../testing.ts`). Never set this against a production
   * endpoint -- `oauth4webapi` defaults to HTTPS-only as a hard security
   * guard, and this flag is the documented, explicit opt-out of that guard.
   */
  readonly allowInsecureRequests?: boolean;
}

/**
 * D-09's narrow revocation-signal classifier: only an
 * `oauth.ResponseBodyError` whose `.error` is exactly `"invalid_grant"`
 * counts as provider-side revocation. Every other thrown value (network
 * failure, 5xx, a non-auth 4xx, or any other OAuth error code) is a
 * `transient_error` -- a single blip must never revoke a lease.
 */
export function classifyTokenError(err: unknown): "provider_revoked" | "transient_error" {
  if (err instanceof oauth.ResponseBodyError && err.error === "invalid_grant") {
    return "provider_revoked";
  }
  return "transient_error";
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
    const requestOptions: oauth.RevocationRequestOptions = {};
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
  credential: SeededCredential,
  now: number,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  try {
    const requestOptions: oauth.TokenEndpointRequestOptions = {
      additionalParameters: { resource: credential.resourceIndicator },
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
    return { kind: "transient_error", cause: err };
  }
}
