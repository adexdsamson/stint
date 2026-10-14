/**
 * Durable credential custody for a lease: which credentials a lease is
 * expected to hold, which of those the store cannot currently produce, and
 * seeding credentials into the store.
 *
 * Fail-closed rules (TEAR-07):
 *  - The expected set is the UNION of the recorded `grants` artifact and the
 *    delegated resources of the signed, re-verified manifest, so a deleted or
 *    edited artifact can never shrink what must be revoked. A malformed
 *    artifact is ignored, never trusted.
 *  - A store that throws while checking reports every expected credential
 *    missing.
 *  - Seeding is put-if-absent: a credential already in the store may carry a
 *    refresh token the provider has since rotated, so a (possibly stale) file
 *    never overwrites it.
 *
 * Nothing here returns or logs a credential value.
 */

import { SecretKeyError, credentialSecretKey, parseGrantsArtifact } from "@stint/core";
import type { GrantRecord } from "@stint/core";
import { isApiKeyCredential, serializeStoredCredential } from "@stint/proxy";
import type { OAuthSeededCredential, SeededCredential } from "@stint/proxy";
import type { Manifest } from "@stint/spec";

import { API_KEY_ORIGIN_UNRESOLVED, apiKeyOriginFor, normalizeApiKeyOrigin } from "./api-key-providers.js";
import { RuntimeError } from "./errors.js";
import type { RuntimePorts } from "./ports.js";

export interface SeedResult {
  /** Resources newly written to the store, sorted. */
  readonly written: readonly string[];
  /** Resources left untouched because the store already held a credential, sorted. */
  readonly skipped: readonly string[];
}

/**
 * An API key as a host holds it BEFORE seeding: the `origin` is optional
 * because a credentials-file entry or an interactively entered key names none.
 * Seeding binds exactly one origin to it (`seedLeaseCredentials`) or refuses.
 */
export interface UnboundApiKeyCredential {
  readonly kind: "api_key";
  readonly key: string;
  readonly origin?: string;
}

/** What a host may hand to {@link seedLeaseCredentials}: an OAuth grant, or an API key with or without its origin. */
export type SeedableCredential = OAuthSeededCredential | UnboundApiKeyCredential;

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The stored form of one credential. An API key leaves here with exactly one
 * normalized origin (D-B): its own when it carries one (which must be https or
 * loopback http), else the closed-table origin for its resource's provider
 * (`enrich` has already applied a profile override). No resolvable origin is a
 * fixed usage error before anything is written. Never interpolates a value.
 */
function bindCredential(
  resource: string,
  credential: SeedableCredential,
  manifest: Manifest | undefined,
): SeededCredential {
  if (credential.kind !== "api_key") return credential;
  const origin =
    credential.origin !== undefined
      ? normalizeApiKeyOrigin(credential.origin)
      : manifest === undefined
        ? undefined
        : apiKeyOriginFor(manifest, resource);
  if (origin === undefined) throw new RuntimeError("usage", API_KEY_ORIGIN_UNRESOLVED);
  return { kind: "api_key", key: credential.key, origin };
}

/** Every credential resource the lease is expected to hold, de-duplicated and sorted ascending. */
export async function expectedCredentialResources(
  ports: Pick<RuntimePorts, "artifacts">,
  leaseId: string,
  manifest: Manifest,
): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const grant of manifest.auth.delegated ?? []) {
    for (const resource of grant.resources) names.add(resource);
  }
  const recorded = parseGrantsArtifact(await ports.artifacts.get(leaseId, "grants"));
  for (const grant of recorded?.grants ?? []) names.add(grant.resource);
  return [...names].sort(byName);
}

/**
 * The subset of `expected` the store cannot produce, sorted. A store error is
 * treated as every expected credential being missing.
 */
export async function missingCredentials(
  ports: Pick<RuntimePorts, "secrets">,
  leaseId: string,
  expected: readonly string[],
): Promise<readonly string[]> {
  const sorted = [...expected].sort(byName);
  try {
    const missing: string[] = [];
    for (const resource of sorted) {
      const value = await ports.secrets.get(credentialSecretKey(leaseId, resource));
      if (value === undefined) missing.push(resource);
    }
    return missing;
  } catch {
    return sorted;
  }
}

function grantFor(resource: string, credential: SeededCredential): GrantRecord {
  if (isApiKeyCredential(credential)) return { resource, kind: "api_key", revocation: "unsupported" };
  return {
    resource,
    kind: "oauth",
    revocation: credential.revocationEndpoint === undefined ? "unsupported" : "supported",
  };
}

/**
 * Writes each credential the store does not already hold and records every
 * seeded resource (kind and revocation capability) in the grants artifact.
 * `enrich` runs before the write, for a host that fills in non-secret fields.
 * An API key is bound to exactly one origin first (file entry, then `enrich`,
 * then the closed table via `manifest`); one that resolves to none refuses the
 * whole call with a fixed usage error before any write.
 */
export async function seedLeaseCredentials(
  ports: Pick<RuntimePorts, "secrets" | "artifacts">,
  leaseId: string,
  credentials: Readonly<Record<string, SeedableCredential>>,
  opts: {
    readonly enrich?: (resource: string, credential: SeedableCredential) => SeedableCredential;
    /** The lease's verified manifest: how an API key without an origin finds its provider's table origin. */
    readonly manifest?: Manifest;
  } = {},
): Promise<SeedResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  const records = new Map<string, GrantRecord>();

  const existing = parseGrantsArtifact(await ports.artifacts.get(leaseId, "grants"));
  for (const grant of existing?.grants ?? []) records.set(grant.resource, grant);

  // Validate every name before writing anything, so a hostile name fails the whole call cleanly.
  const plan: { resource: string; key: string; credential: SeededCredential }[] = [];
  for (const resource of Object.keys(credentials).sort(byName)) {
    const raw = credentials[resource];
    if (raw === undefined) continue;
    const credential = bindCredential(
      resource,
      opts.enrich === undefined ? raw : opts.enrich(resource, raw),
      opts.manifest,
    );
    try {
      plan.push({ resource, key: credentialSecretKey(leaseId, resource), credential });
    } catch (err) {
      if (err instanceof SecretKeyError) {
        throw new RuntimeError("usage", "The credentials file has an unexpected shape.");
      }
      throw err;
    }
  }

  for (const { resource, key, credential } of plan) {
    if ((await ports.secrets.get(key)) === undefined) {
      await ports.secrets.put(key, serializeStoredCredential(credential));
      written.push(resource);
      records.set(resource, grantFor(resource, credential));
    } else {
      skipped.push(resource);
      // The store's copy wins; only note the resource when nothing was recorded for it.
      if (!records.has(resource)) records.set(resource, grantFor(resource, credential));
    }
  }

  if (records.size > 0) {
    const grants = [...records.values()].sort((a, b) => byName(a.resource, b.resource));
    await ports.artifacts.put(leaseId, "grants", { version: 1, grants });
  }
  return { written, skipped };
}
