/**
 * The closed table of providers whose delegated credentials are API keys
 * (Phase 10 D-B). This is runtime-owned configuration: never a manifest field,
 * never agent input. Membership decides which delegated resources the CLI
 * prompts for an API key (plan 10-02); the VALUES are the provider origins a
 * key is bound to at seed time, which plan 10-03 consumes via `apiKeyOriginFor`.
 *
 * Seed-time origin resolution (10-03, CRED-02, D-B), first match wins:
 *   1. the credentials-file entry's own `origin` (applied by the seed funnel),
 *   2. the run profile's `providerOrigins[provider]` (an operator override,
 *      https or loopback http only; the loopback escape hatch for test setups),
 *   3. the closed {@link API_KEY_PROVIDERS} table.
 * No match is a hard seed error, never a guess. Every origin is https or
 * loopback http and is stored normalized (`new URL(x).origin`).
 */

import { isSecureOrLoopbackOrigin } from "@stint/proxy";
import type { Manifest } from "@stint/spec";

/** Provider name to the origin its API key is bound to. v0.2's only entry is paystack. */
export const API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  paystack: "https://api.paystack.co",
};

/** The fixed usage message when an API key has no origin it can be bound to. It names no resource and no value. */
export const API_KEY_ORIGIN_UNRESOLVED =
  "An API key has no provider origin to be bound to; add an origin to its credentials-file entry.";

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

/**
 * The normalized origin (`new URL(value).origin`) of `value`, or `undefined`
 * unless it is `https:` or plain `http:` to a loopback host. The one intake
 * rule for every API-key origin (file entry, profile override, table).
 */
export function normalizeApiKeyOrigin(value: string): string | undefined {
  return isSecureOrLoopbackOrigin(value) ? new URL(value).origin : undefined;
}

/**
 * The origin an API key for `resource` is bound to when its file entry named
 * none: the run profile's `overrides[provider]` when present, else the closed
 * table. The provider is found through `manifest.auth.delegated` and must be a
 * table provider; any other resource resolves to `undefined`. An override that
 * is not https or loopback http fails closed (`undefined`), it never falls
 * back to the table. Pure: no mutation, no I/O.
 */
export function apiKeyOriginFor(
  manifest: Manifest,
  resource: string,
  overrides?: Readonly<Record<string, string>>,
): string | undefined {
  for (const grant of manifest.auth.delegated ?? []) {
    if (!grant.resources.includes(resource)) continue;
    if (!Object.hasOwn(API_KEY_PROVIDERS, grant.provider)) continue;
    const candidate =
      overrides !== undefined && Object.hasOwn(overrides, grant.provider)
        ? overrides[grant.provider]
        : API_KEY_PROVIDERS[grant.provider];
    const origin = candidate === undefined ? undefined : normalizeApiKeyOrigin(candidate);
    if (origin !== undefined) return origin;
  }
  return undefined;
}
