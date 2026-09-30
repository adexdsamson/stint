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

/** The raw OAuth credential the vault resolved for this call -- the access token shape ONLY, never the publisher license (LIC-05, D-15). */
export interface OutboundCredential {
  readonly accessToken: string;
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
      const response = await fetchImpl(binding.resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(resolvedArgs),
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
