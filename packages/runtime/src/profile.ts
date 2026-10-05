/**
 * The non-secret run profile and the enrichment it applies to credentials
 * seeded at run time. `catalog`, `bindings` and the OAuth client identity are
 * runtime-owned inputs: they never come from the manifest and never from the
 * agent. Loading a profile from a file is a host concern and lives in the host.
 */

import type { BindingSet } from "@stint/core";
import type { OAuthClient, SeededCredential, ToolCatalog } from "@stint/proxy";
import { isApiKeyCredential } from "@stint/proxy";

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
}

/**
 * Returns a function that fills in the non-secret client fields an OAuth
 * credential lacks, from the profile's client: `clientId` and
 * `revocationEndpoint` (the latter only when the profile's authorization
 * server defines one). Fields the credential already carries win. An API key
 * is returned unchanged. The returned copy is what gets stored, so a later
 * cleanup with no profile can still revoke.
 */
export function enrichFromProfile(
  profile: RunProfile,
): (resource: string, credential: SeededCredential) => SeededCredential {
  return (_resource, credential) => {
    if (isApiKeyCredential(credential)) return credential;
    const revocationEndpoint = credential.revocationEndpoint ?? profile.oauth.as.revocation_endpoint;
    return {
      ...credential,
      clientId: credential.clientId ?? profile.oauth.client.client_id,
      ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    };
  };
}
