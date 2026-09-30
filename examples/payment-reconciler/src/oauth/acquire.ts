/**
 * Headless OAuth 2.1 authorization-code + PKCE acquisition (D-05).
 *
 * This is the host/platform's "consent UX" stand-in: the user agent is a plain
 * `fetch` with `redirect: "manual"`, because the mock authorization server has
 * no login page and answers `/authorize` with an immediate 302 carrying `code`
 * and `state`. The resulting credential matches the `--credentials` file shape
 * the runtime already consumes (`LoadedCredential`), one entry per resource,
 * each bound to its own RFC 8707 `resource` indicator.
 *
 * PKCE verifier/challenge/state and the redirect validation come from
 * `oauth4webapi` (no hand-rolled crypto). `allowInsecureRequests` is set ONLY
 * because the mock AS is loopback plain HTTP; it never applies to a production
 * endpoint (T-07-INSECURE). The tokens this module returns are SECRETS: they go
 * only into the credentials file / the in-memory vault, never into logs.
 *
 * Deliberately does NOT import `@stint/core/testing` (vitest at module top,
 * Pitfall 5) or anything test-runner shaped.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LoadedCredential } from "@stint/cli";
import * as oauth from "oauth4webapi";

/** A redirect target the mock AS requires to parse as a URL; it is never contacted. */
const REDIRECT_URI = "http://127.0.0.1:9/callback";

/** The default access-token lifetime when the AS omits `expires_in`. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/** Inputs for one grant acquisition against one authorization server. */
export interface AcquireGrantOptions {
  /** The AS issuer URL exactly as the AS reports it (id-token `iss` check). */
  readonly issuerUrl: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  /** The RFC 8707 resource indicator this grant is bound to (e.g. `paystack.transactions`). */
  readonly resource: string;
  /** The authorization endpoint; defaults to `<issuerUrl>/authorize` (the mock AS). */
  readonly authorizationEndpoint?: string;
  /** Epoch-seconds clock used for the credential `expiry`; defaults to wall-clock time. */
  readonly now?: () => number;
}

/** The structural slice of a mock-AS harness that acquisition needs (`MockAuthHarness` satisfies it). */
export interface AcquireHarness {
  readonly issuerUrl: string;
  readonly oauthClient: {
    readonly as: { readonly token_endpoint?: string; readonly revocation_endpoint?: string };
    readonly client: { readonly client_id: string };
  };
}

function wallClockSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Runs the headless auth-code + PKCE flow for one resource and returns a
 * `LoadedCredential`-shaped value. Any failure throws a fixed-message error:
 * AS response text and tokens are never interpolated.
 */
export async function acquireGrant(options: AcquireGrantOptions): Promise<LoadedCredential> {
  const { issuerUrl, tokenEndpoint, revocationEndpoint, clientId, resource } = options;
  const now = options.now ?? wallClockSeconds;

  const as: oauth.AuthorizationServer = {
    issuer: issuerUrl,
    token_endpoint: tokenEndpoint,
    ...(revocationEndpoint === undefined ? {} : { revocation_endpoint: revocationEndpoint }),
  };
  const client: oauth.Client = { client_id: clientId };
  const clientAuth = oauth.None();

  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);

  const authUrl = new URL(options.authorizationEndpoint ?? `${issuerUrl}/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", resource);

  // The "user agent": the mock AS has no login UI, the 302 already carries the code.
  const hop = await fetch(authUrl, { redirect: "manual" });
  const location = hop.headers.get("location");
  await hop.body?.cancel().catch(() => undefined);
  if (location === null) {
    throw new Error("OAuth acquisition failed: the authorization server did not redirect.");
  }

  // validateAuthResponse checks `state` (CSRF) and any `iss`/`error` per RFC 9207 (T-07-CSRF).
  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(as, client, new URL(location), state);
  } catch {
    throw new Error("OAuth acquisition failed: the authorization response was invalid.");
  }

  let tokens: oauth.TokenEndpointResponse;
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuth,
      params,
      REDIRECT_URI,
      verifier,
      {
        additionalParameters: { resource },
        // Deliberate: only ever a loopback mock AS over plain HTTP (T-07-INSECURE).
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        [oauth.allowInsecureRequests]: true,
      },
    );
    tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
  } catch {
    throw new Error("OAuth acquisition failed: the token exchange was refused.");
  }

  if (tokens.refresh_token === undefined) {
    throw new Error("OAuth acquisition failed: the authorization server issued no refresh token.");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: Math.floor(now()) + (tokens.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS),
    tokenEndpoint,
    resourceIndicator: resource,
    clientId,
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
  };
}

/**
 * Acquires one grant per resource against the mock AS `harness` and returns the
 * credentials-file map `{ "<resource>": LoadedCredential }`. Grants run
 * sequentially so the mock AS sees a deterministic request order.
 */
export async function acquireCredentialsFile(
  harness: AcquireHarness,
  resources: readonly string[],
  now?: () => number,
): Promise<Record<string, LoadedCredential>> {
  const tokenEndpoint = harness.oauthClient.as.token_endpoint ?? `${harness.issuerUrl}/token`;
  const revocationEndpoint = harness.oauthClient.as.revocation_endpoint;
  const credentials: Record<string, LoadedCredential> = {};
  for (const resource of resources) {
    credentials[resource] = await acquireGrant({
      issuerUrl: harness.issuerUrl,
      tokenEndpoint,
      ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
      clientId: harness.oauthClient.client.client_id,
      resource,
      ...(now === undefined ? {} : { now }),
    });
  }
  return credentials;
}

/**
 * Writes the credentials map to `file` (the `--credentials` argument of a
 * spawned `stint run`). The file holds SECRETS: it is created owner-only where
 * the platform honors modes and must live in a temp directory the caller removes.
 */
export async function writeCredentialsFile(
  credentials: Readonly<Record<string, LoadedCredential>>,
  file: string,
): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
  return file;
}
