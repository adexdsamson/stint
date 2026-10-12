/**
 * The closed table of providers whose delegated credentials are API keys
 * (Phase 10 D-B). This is runtime-owned configuration: never a manifest field,
 * never agent input. Membership decides which delegated resources the CLI
 * prompts for an API key (plan 10-02); the VALUES are the provider origins a
 * key is bound to at seed time, which plan 10-03 consumes via `apiKeyOriginFor`.
 */

import type { Manifest } from "@stint/spec";

/** Provider name to the origin its API key is bound to. v0.2's only entry is paystack. */
export const API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  paystack: "https://api.paystack.co",
};

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The delegated provider names from `manifest.auth.delegated` that take API
 * keys (their name is a key of {@link API_KEY_PROVIDERS}), de-duplicated and
 * sorted. Reads nothing else from the manifest and mutates nothing.
 */
export function delegatedApiKeyProviders(manifest: Manifest): readonly string[] {
  const names = new Set<string>();
  for (const grant of manifest.auth.delegated ?? []) {
    if (Object.hasOwn(API_KEY_PROVIDERS, grant.provider)) names.add(grant.provider);
  }
  return [...names].sort(byName);
}
