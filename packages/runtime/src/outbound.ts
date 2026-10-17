/**
 * The runtime's composed outbound connector (Phase 10, PSTK-01, PSTK-04): the
 * closed-table dispatch over the hardened REST connector and the Paystack
 * verify connector.
 *
 * A call goes to the verify connector exactly when its credential is an API key
 * AND its resource is a key of the proxy's closed `API_KEY_RESOURCE_ROUTES`
 * table; every other call (OAuth anywhere, an API key outside the table) stays
 * on the REST connector with its POST flow and origin pinning unchanged. The
 * table keys on the credential kind, so an OAuth-credentialed paystack resource
 * keeps the reconciler's existing POST behaviour.
 *
 * The verify connector builds its URL from the credential's recorded origin and
 * the lease-bound job parameters, so the endpoints map serves only the REST
 * connector: one source of truth for where a key may go.
 */

import {
  API_KEY_RESOURCE_ROUTES,
  createPaystackVerifyConnector,
  createRestOutboundConnector,
  transactionExpectationFromParameters,
} from "@stint/proxy";
import type { FetchLike, OutboundConnector } from "@stint/proxy";

export interface RuntimeConnectorOptions {
  /** The fetch both connectors use (global fetch in a real run, a double in tests). */
  readonly fetchImpl: FetchLike;
  /** The profile's identifier -> URL map; applied to the REST connector only. */
  readonly endpoints?: Readonly<Record<string, string>>;
  /**
   * Reads the lease-bound job parameters at call time. They are written once at
   * create and never change; a lease without usable parameters makes the verify
   * route refuse (zero fetch).
   */
  readonly jobParameters?: () => Readonly<Record<string, string | number>> | undefined;
}

/** Applies the profile's identifier -> URL map before delegating; unmapped identifiers pass through unchanged. */
function mapEndpoints(base: FetchLike, endpoints: Readonly<Record<string, string>> | undefined): FetchLike {
  if (endpoints === undefined) return base;
  return (input, init) => {
    const target = Object.hasOwn(endpoints, input) ? endpoints[input] : undefined;
    return base(target ?? input, init);
  };
}

/**
 * Builds the connector a lease run (and an outcome check) hands to the vault
 * execute stage and the verifier read: one instance, so both paths share the
 * same dispatch.
 */
export function createRuntimeOutboundConnector(options: RuntimeConnectorOptions): OutboundConnector {
  const rest = createRestOutboundConnector(mapEndpoints(options.fetchImpl, options.endpoints));
  const verify = createPaystackVerifyConnector(options.fetchImpl, {
    expectation: () => transactionExpectationFromParameters(options.jobParameters?.()),
  });
  return {
    execute(binding, resolvedArgs, credential) {
      if (credential.kind === "api_key" && Object.hasOwn(API_KEY_RESOURCE_ROUTES, binding.resource)) {
        return verify.execute(binding, resolvedArgs, credential);
      }
      return rest.execute(binding, resolvedArgs, credential);
    },
  };
}
