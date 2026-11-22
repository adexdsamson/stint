/**
 * Seeds the SecretStore from a parsed credentials file and, when the active
 * backend is the plaintext file store, tells the user in the same command that
 * the store keeps credentials unencrypted (D-06, D-09, D-10).
 *
 * The warning is one line on `deps.io.err`, printed only when something was
 * actually written to the plaintext file store. Under the keychain (the default
 * custody, KEYC-03) it is never printed, because it would be false. The only way
 * to get the file store is `STINT_SECRET_STORE=file`, and then nothing
 * suppresses the warning. It never carries a credential value.
 */

import type { ConsentCredential, ConsentCustody, GrantRecord, GrantsArtifact } from "@stint/core";
import { seedLeaseCredentials } from "@stint/runtime";
import type { RuntimePorts, SeedResult, SeedableCredential } from "@stint/runtime";
import type { Manifest } from "@stint/spec";

import type { CliDeps } from "./deps.js";
import { PLAINTEXT_WARNING, PLAINTEXT_WARNING_WINDOWS } from "./messages.js";
import { assertSecretStoreAvailable } from "./store/default-secret-store.js";
import type { SecretBackend } from "./store/default-secret-store.js";
import { toCliError } from "./runtime-errors.js";
import type { LoadedCredential } from "./run/credentials.js";

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The custody `deps.secrets` provides; absent means the plaintext file store (in-process test deps). */
export function secretBackendOf(deps: Pick<CliDeps, "secretBackend">): SecretBackend {
  return deps.secretBackend ?? "plaintext_file";
}

/**
 * Refuses, with the fixed "keychain not available" message, when the active
 * backend cannot hold a secret. Commands call it BEFORE any prompt, consent or
 * write that would put a credential in the store, so an unavailable keychain
 * never leaves a half-made lease or surfaces native error text. The plaintext
 * file backend needs no probe.
 */
export async function ensureSecretCustody(
  deps: Pick<CliDeps, "secretBackend" | "platform" | "keychainBinding">,
  root: string,
): Promise<void> {
  await assertSecretStoreAvailable({
    root,
    backend: secretBackendOf(deps),
    platform: deps.platform ?? process.platform,
    ...(deps.keychainBinding === undefined ? {} : { binding: deps.keychainBinding }),
  });
}

/**
 * What consent can honestly say about the credentials a lease will hold (D-14,
 * D-28). The resource list is the sorted union of the manifest's delegated
 * resources and the credentials file's keys. Capability comes from the file
 * entry: an OAuth credential is `supported` only when it carries a revocation
 * endpoint; an API-key entry is always `unsupported` (there is no endpoint to
 * call); a resource with no file entry is `unknown`, never `supported`. No
 * secret value is read into the result. `storage` is the active backend, so the
 * consent screen names where the credentials will actually be kept.
 */
export function buildConsentCustody(
  manifest: Manifest,
  credentials: Readonly<Record<string, LoadedCredential>> | undefined,
  storage: SecretBackend = "plaintext_file",
): ConsentCustody {
  const names = new Set<string>();
  for (const grant of manifest.auth.delegated ?? []) {
    for (const resource of grant.resources) names.add(resource);
  }
  for (const resource of Object.keys(credentials ?? {})) names.add(resource);
  if (names.size === 0) return { storage: "none", credentials: [] };

  const list: ConsentCredential[] = [...names].sort(byName).map((resource) => {
    const entry = credentials?.[resource];
    // An API key has no revocation endpoint to call, so consent is always honest
    // about it: kind api_key, revocation unsupported (SPEC-10, 10-02).
    if (entry !== undefined && entry.kind === "api_key") {
      return { resource, kind: "api_key", revocation: "unsupported" } as const;
    }
    const revocation =
      entry === undefined
        ? "unknown"
        : entry.revocationEndpoint === undefined
          ? "unsupported"
          : "supported";
    return { resource, kind: "oauth", revocation } as const;
  });
  return { storage, credentials: list };
}

/** The grants artifact for a lease: every resource consent listed, with its capability when known. */
export function grantsFromCustody(custody: ConsentCustody): GrantsArtifact {
  const grants: GrantRecord[] = custody.credentials.map((credential) =>
    credential.revocation === "unknown"
      ? { resource: credential.resource, kind: credential.kind }
      : { resource: credential.resource, kind: credential.kind, revocation: credential.revocation },
  );
  return { version: 1, grants };
}

export async function seedFromCredentials(
  deps: CliDeps,
  ports: RuntimePorts,
  leaseId: string,
  credentials: Readonly<Record<string, SeedableCredential>>,
  opts: {
    /** Fills in non-secret fields before each credential is written (for example from a run profile). */
    readonly enrich?: (resource: string, credential: SeedableCredential) => SeedableCredential;
    /** The lease's manifest: how an API key with no origin finds its provider's table origin (10-03). */
    readonly manifest?: Manifest;
  } = {},
): Promise<SeedResult> {
  let result: SeedResult;
  try {
    result = await seedLeaseCredentials(
      ports,
      leaseId,
      credentials,
      {
        ...(opts.enrich === undefined ? {} : { enrich: opts.enrich }),
        ...(opts.manifest === undefined ? {} : { manifest: opts.manifest }),
      },
    );
  } catch (error) {
    throw toCliError(error);
  }
  if (result.written.length > 0 && secretBackendOf(deps) === "plaintext_file") {
    const windows = (deps.platform ?? process.platform) === "win32";
    deps.io.err(
      `stint: ${PLAINTEXT_WARNING}${windows ? ` ${PLAINTEXT_WARNING_WINDOWS}` : ""}\n`,
    );
  }
  return result;
}
