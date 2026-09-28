/**
 * `@stint/proxy/testing` — the ONLY place proxy test doubles (mock
 * `OutboundConnector` implementations, mock OAuth server wiring, contract
 * test factories for proxy-owned stores) will live, mirroring
 * `@stint/core/testing`'s subpath convention (D-14 there; same discipline
 * here). The public `.` entry (`./index.ts`) never re-exports anything from
 * this file, so production code cannot accidentally depend on a test
 * double.
 *
 * `createEchoExecuteStage` is this plan's first real test double: a
 * trivial in-memory `ExecuteStage` (D-01) for the tracer test and future
 * examples.
 *
 * `createEchoingCredentialConnector`/`createThrowingCredentialConnector`
 * (plan 04-06, PRXY-06) are the adversarial `OutboundConnector` doubles the
 * secretless boundary tests aim at `vault/execute-stage.ts`: each tries to
 * leak the credential it was handed -- one by echoing it into the response
 * body, the other by embedding it in a thrown error's message -- so a test
 * can prove the vault-backed `ExecuteStage`'s scrubber actually strips it
 * before it reaches the agent-facing boundary.
 *
 * `startMockAuthServer` (plan 04-05, PRXY-08) is the mock-AS test harness
 * every Phase 4 OAuth test drives: a loopback `oauth2-mock-server`
 * `OAuth2Server` signed with an RS256 key (NOT EdDSA -- the mock's refresh
 * grant also issues an `id_token`, and its discovery document hardcodes
 * `id_token_signing_alg_values_supported: ["RS256"]` regardless of which key
 * algorithm was actually generated; `oauth4webapi` validates that token's
 * `alg` against the advertised value, so anything but RS256 throws). It
 * exposes a live `tokenEndpointHits` counter and `lastTokenRequestBody`
 * (both incremented/captured via the `Events.BeforeResponse` hook -- proven
 * hands-on in 04-RESEARCH.md to fire once per `POST /token` request, before
 * the response is sent) and `forceNextTokenError(errorCode)`, a one-shot
 * override that makes the NEXT token-endpoint response `{ error: errorCode
 * }` -- the only way to exercise `oauth.ResponseBodyError` classification
 * against this mock server, since its real `/revoke` endpoint always
 * returns 200 with no reuse-detection (04-RESEARCH.md Pitfall 2/5/6).
 */

import * as oauth from "oauth4webapi";
import { Events, OAuth2Server } from "oauth2-mock-server";
import type { MutableResponse, TokenRequestIncomingMessage } from "oauth2-mock-server";

import type { ExecuteStage } from "./dispatch.js";
import type { OutboundConnector } from "./connectors/outbound-connector.js";
import type { OAuthClient } from "./vault/oauth-client.js";

/** Placeholder marker proving this subpath builds and is importable; later plans replace/extend this. */
export const PROXY_TESTING_PLACEHOLDER = "@stint/proxy/testing";

/**
 * A trivial in-memory `ExecuteStage` that echoes a fixed `{ status: 200,
 * body }` result on every call -- never wired into a production `ProxyDeps`
 * by default (`dispatch.ts`'s own `DEFAULT_EXECUTE_STAGE` throws instead).
 */
export function createEchoExecuteStage(body: unknown = { echo: true }): ExecuteStage {
  return {
    execute() {
      return Promise.resolve({ status: 200, body });
    },
  };
}

/**
 * An adversarial `OutboundConnector` (D-01) that echoes the credential it
 * was handed into its response body -- e.g. `{ status: 200, body: { leaked:
 * credential.accessToken } }`. Wired into the vault-backed `ExecuteStage`
 * (`vault/execute-stage.ts`), this proves `scrubCredential` actually strips
 * the token from a real port response before it reaches the agent-facing
 * `CallToolResult` (PRXY-06) -- never wired into a production `ProxyDeps`.
 */
export function createEchoingCredentialConnector(): OutboundConnector {
  return {
    execute(_binding, _resolvedArgs, credential) {
      return Promise.resolve({ status: 200, body: { leaked: credential.accessToken } });
    },
  };
}

/**
 * An adversarial `OutboundConnector` (D-01) that throws an `Error` whose
 * message embeds the credential it was handed. Wired into the vault-backed
 * `ExecuteStage`, this proves `scrubError` strips the token from a thrown
 * error before it can propagate toward the agent-facing boundary (PRXY-06)
 * -- never wired into a production `ProxyDeps`.
 */
export function createThrowingCredentialConnector(): OutboundConnector {
  return {
    execute(_binding, _resolvedArgs, credential) {
      return Promise.reject(new Error(`connector failure -- leaked token: ${credential.accessToken}`));
    },
  };
}

/**
 * A running loopback `oauth2-mock-server` instance plus everything a
 * PRXY-08 test needs to drive and observe it: the discovered `as`/`client`
 * bundle ready to hand to `refreshAccessToken`/`createCredentialVault`, a
 * live token-endpoint-hit counter (the ONLY honest proof of single-flight
 * refresh -- 04-RESEARCH.md Pitfall 6), the last request body sent to the
 * token endpoint (to assert the RFC 8707 `resource` indicator was
 * transmitted), and a one-shot forced-error hook for classification tests.
 */
export interface MockAuthHarness {
  readonly issuerUrl: string;
  /** Pre-bundled `{ as, client, clientAuth }` ready for `refreshAccessToken`/`createCredentialVault`. */
  readonly oauthClient: OAuthClient;
  /** The exact number of `POST /token` requests this server has received so far. */
  readonly tokenEndpointHits: number;
  /** The most recent `POST /token` request body (form-decoded), or `undefined` before the first request. */
  readonly lastTokenRequestBody: Readonly<Record<string, unknown>> | undefined;
  /** Arms a ONE-SHOT override: the next token-endpoint response body becomes `{ error: errorCode }` with HTTP 400. */
  forceNextTokenError(errorCode: string): void;
  /** Stops the loopback HTTP server. Always call in an `afterEach`/`finally`. */
  stop(): Promise<void>;
}

/**
 * Starts a fresh loopback `oauth2-mock-server`, generates its RS256 signing
 * key, runs OIDC discovery against it (`algorithm: 'oidc'` -- this mock only
 * serves `/.well-known/openid-configuration`, not the plain-OAuth2 RFC 8414
 * path `algorithm: 'oauth2'` would request), and wires the
 * `Events.BeforeResponse` hook that backs `tokenEndpointHits`,
 * `lastTokenRequestBody`, and `forceNextTokenError`. Every `oauth4webapi`
 * call this harness makes (discovery included) passes
 * `[oauth.allowInsecureRequests]: true`, since the mock only ever serves
 * plain HTTP on `localhost`.
 */
export async function startMockAuthServer(): Promise<MockAuthHarness> {
  const server = new OAuth2Server();
  await server.issuer.keys.generate("RS256");
  await server.start(0, "localhost");

  const issuerUrl = server.issuer.url;
  if (issuerUrl === undefined) {
    throw new Error("@stint/proxy/testing: mock authorization server failed to report its issuer URL.");
  }

  let tokenEndpointHits = 0;
  let lastTokenRequestBody: Record<string, unknown> | undefined;
  let forcedError: string | undefined;

  server.service.on(Events.BeforeResponse, (response: MutableResponse, req: TokenRequestIncomingMessage) => {
    tokenEndpointHits += 1;
    lastTokenRequestBody = { ...(req.body as unknown as Record<string, unknown>) };
    if (forcedError !== undefined) {
      response.statusCode = 400;
      response.body = { error: forcedError };
      forcedError = undefined;
    }
  });

  // Deliberate: this harness only ever talks to a loopback oauth2-mock-server
  // instance over plain HTTP; production OAuthClient wiring never sets this
  // flag (oauth-client.ts threads it through an explicit, opt-in
  // RefreshOptions flag instead of hardcoding it).
  const discoveryResponse = await oauth.discoveryRequest(new URL(issuerUrl), {
    algorithm: "oidc",
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    [oauth.allowInsecureRequests]: true,
  });
  const as = await oauth.processDiscoveryResponse(new URL(issuerUrl), discoveryResponse);

  const oauthClient: OAuthClient = {
    as,
    client: { client_id: "stint-test-client" },
    clientAuth: oauth.None(),
  };

  return {
    issuerUrl,
    oauthClient,
    get tokenEndpointHits(): number {
      return tokenEndpointHits;
    },
    get lastTokenRequestBody(): Readonly<Record<string, unknown>> | undefined {
      return lastTokenRequestBody;
    },
    forceNextTokenError(errorCode: string): void {
      forcedError = errorCode;
    },
    async stop(): Promise<void> {
      await server.stop();
    },
  };
}
