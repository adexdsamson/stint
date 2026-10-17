/**
 * The non-secret run profile and the enrichment it applies to credentials
 * seeded at run time. `catalog`, `bindings` and the OAuth client identity are
 * runtime-owned inputs: they never come from the manifest and never from the
 * agent. Loading a profile from a file is a host concern and lives in the host.
 */

import type { BindingSet } from "@stint/core";
import type { OAuthClient, ToolCatalog } from "@stint/proxy";
import type { Manifest } from "@stint/spec";

import { apiKeyOriginFor } from "./api-key-providers.js";
import type { SeedableCredential } from "./custody.js";

export interface RunProfile {
  readonly catalog: ToolCatalog;
  readonly bindings: BindingSet;
  readonly oauth: OAuthClient;
  /**
   * Optional map from a binding's resource identifier (for example
   * `paystack.transactions`) to the URL the REST connector must call.
   * Runtime-owned configuration: never from the manifest, never from the agent.
   */
  readonly endpoints?: Readonly<Record<string, string>>;
  /**
   * Optional map from a provider name (for example `paystack`) to the origin
   * its API key is bound to at seed time, overriding the closed
   * `API_KEY_PROVIDERS` table (10-03, CRED-02). `https:` or loopback `http:`
   * only. Runtime-owned configuration: never from the manifest or the agent;
   * production has no override, so the table is the only real origin.
   */
  readonly providerOrigins?: Readonly<Record<string, string>>;
}

/**
 * Returns a function that fills in the non-secret client fields an OAuth
 * credential lacks, from the profile's client: `clientId` and
 * `revocationEndpoint` (the latter only when the profile's authorization
 * server defines one). Fields the credential already carries win. An API key
 * gains only a MISSING `origin`, from `profile.providerOrigins` then the closed
 * table (this needs `manifest` to find the resource's provider); an origin it
 * already carries is never overwritten, and a key that resolves to none is
 * returned unchanged for the seed to refuse. The returned copy is what gets
 * stored, so a later cleanup with no profile can still revoke.
 */
export function enrichFromProfile(
  profile: RunProfile,
  manifest?: Manifest,
): (resource: string, credential: SeedableCredential) => SeedableCredential {
  return (resource, credential) => {
    if (credential.kind === "api_key") {
      if (credential.origin !== undefined || manifest === undefined) return credential;
      const origin = apiKeyOriginFor(manifest, resource, profile.providerOrigins);
      return origin === undefined ? credential : { ...credential, origin };
    }
    const revocationEndpoint = credential.revocationEndpoint ?? profile.oauth.as.revocation_endpoint;
    return {
      ...credential,
      clientId: credential.clientId ?? profile.oauth.client.client_id,
      ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    };
  };
}
