/**
 * `OutboundConnector` -- the injected downstream-execution port (D-01, D-02,
 * PRXY-06). This is the ONLY place a raw OAuth access token is attached to
 * an outbound, customer-resource-facing request: `vault/execute-stage.ts`
 * (the trusted caller) resolves the token from the credential vault and
 * hands it to `execute(...)` as `credential.accessToken`; the port attaches
 * it (header/param) and performs the actual call. No enforcement-path code
 * in `@stint/proxy` (`dispatch.ts`, `server.ts`, `vault/execute-stage.ts`)
 * imports a concrete `OutboundConnector` implementation directly -- a
 * platform/example always constructor-injects one, mirroring
 * `@stint/core/license/license-issuer.ts`'s `LicenseIssuer` injected-port
 * convention (interface + one reference implementation, never called
 * directly by core proper).
 *
 * `createRestOutboundConnector` is Phase 4's reference implementation: an
 * HTTP/REST client that attaches `credential.accessToken` as a bearer
 * `Authorization` header. RESEARCH.md's Assumption A1 flags this as an
 * assumption, not a guarantee -- if a later phase's downstream connectors
 * turn out to be MCP-shaped instead of REST-shaped, the `OutboundConnector`
 * port absorbs that change without touching this port's signature or any of
 * its callers.
 */

import type { ConnectorBinding } from "@stint/core";

import { isSecureOrLoopbackOrigin } from "../vault/oauth-client.js";

/**
 * The credential the vault resolved for this call -- the access token (or API
 * key) and its kind ONLY, never the publisher license (LIC-05, D-15). `origin`
 * is present whenever `kind` is `"api_key"`: the one origin the key was bound
 * to at seed time (CRED-02, D-B). An `api_key` with no `origin` is a hard
 * connector error (fail closed).
 */
export interface OutboundCredential {
  readonly accessToken: string;
  readonly kind: "oauth" | "api_key";
  readonly origin?: string;
}

/**
 * The abstract downstream-execution port (D-01). `execute` receives the
 * resolved binding, the resolved call arguments, and the credential to
 * attach -- it is the trusted-boundary code where the raw token legitimately
 * appears (D-02). The untrusted boundary is the agent-facing `Server`
 * response/error path (`dispatch.ts`), which `vault/execute-stage.ts`'s
 * scrubber protects.
 */
export interface OutboundConnector {
  execute(
    binding: ConnectorBinding,
    resolvedArgs: Readonly<Record<string, unknown>>,
    credential: OutboundCredential,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

/**
 * Thrown by the reference REST connector, BEFORE any request is made, when an
 * API key would be sent somewhere other than the origin recorded on its stored
 * credential (CRED-02, D-B): a mismatch, a missing or unusable recorded origin,
 * or a URL that does not parse. The message is fixed text: it names neither
 * the URL, the host, nor the key, so nothing sensitive can ride an error up
 * toward the agent-facing boundary.
 */
export class OutboundOriginError extends Error {
  constructor() {
    super("@stint/proxy: refused to send an API key to an origin it was not issued for.");
    this.name = "OutboundOriginError";
  }
}

/** One closed REST route: the HTTP method and the path (relative to the credential's origin) a resource maps to. */
export interface RestRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
}

/**
 * The CLOSED method/path table for API-key resources (Phase 10 D-B, PSTK-04).
 * It is a constant of the proxy: nothing reads it from the run profile, the
 * manifest or the agent, so none of them can steer where a key is sent or with
 * which method. The route itself is implemented by the verify connector
 * (plan 10-04); this table is the contract it implements, and the origin the
 * path is appended to is the credential's recorded origin, never a base path.
 */
export const API_KEY_RESOURCE_ROUTES: Readonly<Record<string, RestRoute>> = Object.freeze({
  "paystack.transactions": Object.freeze({ method: "GET", path: "/transaction/verify/:reference" }),
});

/** The subset of the global `fetch` signature `createRestOutboundConnector` needs -- injectable so tests never perform a real network call. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The Phase 4 reference `OutboundConnector` implementation: a plain
 * HTTP/REST client. Attaches `credential.accessToken` as a bearer
 * `Authorization` header on the outbound request and returns `{ status,
 * body }` -- this function body is the ONLY place in `@stint/proxy` an
 * access token is placed on an actual outbound request. `fetchImpl`
 * defaults to the global `fetch` but is always overridable, so every test
 * exercising this connector injects a double and never performs a real
 * network call.
 */
export function createRestOutboundConnector(fetchImpl: FetchLike = fetch): OutboundConnector {
  return {
    async execute(
      binding: ConnectorBinding,
      resolvedArgs: Readonly<Record<string, unknown>>,
      credential: OutboundCredential,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      // The key meets the URL only here. `binding.resource` is the FINAL url
      // (the caller's mapEndpoints wrapper already translated the identifier),
      // so the origin check below is on what fetch is actually handed.
      if (credential.kind === "api_key") assertSameOrigin(binding.resource, credential.origin);

      const response = await fetchImpl(binding.resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(resolvedArgs),
        // A redirect is an upstream attempt to move the credential: it is an
        // error, never a hop (CRED-02), for API keys and OAuth tokens alike.
        redirect: "error",
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      return { status: response.status, body };
    },
  };
}

/**
 * Fails closed unless `finalUrl` shares an origin with `recordedOrigin`. The
 * recorded origin must itself be https or loopback http. Origin equality only:
 * the path is not constrained (a same-origin base path is permitted).
 */
function assertSameOrigin(finalUrl: string, recordedOrigin: string | undefined): void {
  if (
    recordedOrigin === undefined ||
    !isSecureOrLoopbackOrigin(recordedOrigin) ||
    !URL.canParse(finalUrl) ||
    new URL(finalUrl).origin !== new URL(recordedOrigin).origin
  ) {
    throw new OutboundOriginError();
  }
}
