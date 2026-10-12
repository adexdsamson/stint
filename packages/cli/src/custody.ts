/**
 * Seeds the SecretStore from a parsed credentials file and tells the user, in the
 * same command, that the store keeps credentials unencrypted (D-06, D-09, D-10).
 *
 * The warning is one line on `deps.io.err`, printed only when something was
 * actually written, and there is no option, flag or environment variable that
 * suppresses it. It never carries a credential value.
 */

import type { ConsentCredential, ConsentCustody, GrantRecord, GrantsArtifact } from "@stint/core";
import { isApiKeyCredential } from "@stint/proxy";
import type { SeededCredential } from "@stint/proxy";
import { seedLeaseCredentials } from "@stint/runtime";
import type { RuntimePorts, SeedResult } from "@stint/runtime";
import type { Manifest } from "@stint/spec";

import type { CliDeps } from "./deps.js";
import { PLAINTEXT_WARNING, PLAINTEXT_WARNING_WINDOWS } from "./messages.js";
import { toCliError } from "./runtime-errors.js";
import type { LoadedCredential } from "./run/credentials.js";

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What consent can honestly say about the credentials a lease will hold (D-14,
 * D-28). The resource list is the sorted union of the manifest's delegated
 * resources and the credentials file's keys. Capability comes from the file
 * entry: an OAuth credential is `supported` only when it carries a revocation
 * endpoint; an API-key entry is always `unsupported` (there is no endpoint to
 * call); a resource with no file entry is `unknown`, never `supported`. No
 * secret value is read into the result.
 */
export function buildConsentCustody(
  manifest: Manifest,
  credentials: Readonly<Record<string, LoadedCredential>> | undefined,
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
    if (entry !== undefined && isApiKeyCredential(entry)) {
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
  return { storage: "plaintext_file", credentials: list };
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
  credentials: Readonly<Record<string, SeededCredential>>,
  opts: {
    /** Fills in non-secret fields before each credential is written (for example from a run profile). */
    readonly enrich?: (resource: string, credential: SeededCredential) => SeededCredential;
  } = {},
): Promise<SeedResult> {
  let result: SeedResult;
  try {
    result = await seedLeaseCredentials(
      ports,
      leaseId,
      credentials,
      opts.enrich === undefined ? {} : { enrich: opts.enrich },
    );
  } catch (error) {
    throw toCliError(error);
  }
  if (result.written.length > 0) {
    const windows = (deps.platform ?? process.platform) === "win32";
    deps.io.err(
      `stint: ${PLAINTEXT_WARNING}${windows ? ` ${PLAINTEXT_WARNING_WINDOWS}` : ""}\n`,
    );
  }
  return result;
}
