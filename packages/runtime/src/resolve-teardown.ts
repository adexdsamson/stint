/**
 * `resolveTeardown`: assembles everything teardown needs for one lease from
 * `RuntimePorts` alone (RT-01, D-24). No file system, no terminal and no
 * credentials file: the credential vault is durable (backed by the
 * `SecretStore`), the manifest is re-verified from the stored envelope, and
 * the publisher binding comes from the artifact store. A Phase 9 supervisor
 * calls this directly.
 *
 * The returned handle carries the fail-closed credential check (TEAR-07): the
 * expected credential set is the union of the grants artifact and the signed
 * manifest's delegated resources, and the orchestrator's preflight blocks the
 * teardown, with a `teardown_blocked` receipt and an unchanged lease, when the
 * store cannot produce one of them.
 */

import type { Lease, LicenseIssuer } from "@stint/core";
import {
  createCredentialVault,
  DEFAULT_FENCE_TTL_SECONDS,
  createDefaultTeardownSteps,
  oauthClientFromCredential,
  retryTeardown,
  runTeardown,
} from "@stint/proxy";
import type { LicenseCustody, TeardownDeps, TeardownStep } from "@stint/proxy";
import { resolveAuthMode } from "@stint/spec";
import type { AuthMode, VerifiedManifest } from "@stint/spec";

import { missingCredentials, expectedCredentialResources } from "./custody.js";
import { RuntimeError } from "./errors.js";
import { createPublisherClient } from "./license-http.js";
import { allowInsecureForClient } from "./loopback.js";
import { loadLeaseManifest } from "./manifest.js";
import type { RuntimePorts } from "./ports.js";
import { parsePublisherBinding } from "./publisher-binding.js";

export interface ResolveTeardownInput {
  readonly leaseId: string;
  /** Lets a host (or a test) wrap the five default steps, for example to count or fault one. */
  readonly decorateSteps?: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
  /** How long a teardown fence this pass writes stays valid; defaults to the proxy's DEFAULT_FENCE_TTL_SECONDS (120). */
  readonly fenceTtlSeconds?: number;
}

export interface ResolvedTeardown {
  readonly leaseId: string;
  readonly manifest: VerifiedManifest;
  /** Every credential resource the lease is expected to hold, sorted ascending. */
  readonly expectedResources: readonly string[];
  readonly deps: TeardownDeps;
  /** The expected resources the secret store cannot currently produce. */
  missingCredentials(): Promise<readonly string[]>;
  /** Runs teardown. Rejects with `TeardownBlockedError` when a recorded credential is unavailable. */
  run(now: number): Promise<Lease>;
  /** Resumes a `cleanup_incomplete` lease. Rejects with `TeardownBlockedError` like `run`. */
  retry(actor: "user" | "runtime", now: number): Promise<Lease>;
}

const NO_LICENSE_IN_TEARDOWN = "License issuance is not available during teardown.";

/**
 * The `invalidate_license` collaborator for one lease. Teardown runs without an
 * in-memory held license, so the publisher holds the truth and the step must
 * actually tell it.
 *
 *  - delegated: custody reports no license, so the step is honestly
 *    `not_applicable` and never calls out.
 *  - hosted or hybrid with a stored binding: the step calls the publisher's
 *    invalidate endpoint through the verify-then-mint client.
 *  - hosted or hybrid with no binding: invalidation fails honestly rather than
 *    receipting `ok`.
 *
 * Only `invalidate` is reachable; `issue` and `reissue` refuse.
 */
async function licenseCollaborator(
  ports: Pick<RuntimePorts, "artifacts" | "fetch">,
  leaseId: string,
  mode: AuthMode,
  specVersion: string,
  kid: string,
): Promise<{ readonly issuer: LicenseIssuer; readonly custody: LicenseCustody }> {
  const refuse = (): Promise<never> => Promise.reject(new Error(NO_LICENSE_IN_TEARDOWN));
  const base = { kid, issue: refuse, reissue: refuse };
  const discard = (): void => undefined;

  if (mode === "delegated") {
    return {
      issuer: { ...base, invalidate: () => Promise.resolve() },
      custody: { hasLicense: () => false, discard },
    };
  }
  const stored = await ports.artifacts.get(leaseId, "publisher");
  const binding = stored === undefined ? undefined : parsePublisherBinding(stored);
  if (stored !== undefined && binding === undefined) {
    throw new RuntimeError("store_corrupt", "The stored publisher binding is invalid.");
  }
  if (binding === undefined) {
    return {
      issuer: {
        ...base,
        invalidate: () => Promise.reject(new Error("No publisher binding is stored for the lease.")),
      },
      custody: { hasLicense: () => true, discard },
    };
  }
  const client = await createPublisherClient(binding, specVersion, ports.fetch);
  return {
    issuer: { ...base, invalidate: (id) => client.invalidate(id) },
    custody: { hasLicense: () => true, discard },
  };
}

/**
 * Assembles teardown for `input.leaseId`.
 *
 * @experimental The runtime surface is not yet stable.
 */
export async function resolveTeardown(
  ports: RuntimePorts,
  input: ResolveTeardownInput,
): Promise<ResolvedTeardown> {
  const { leaseId } = input;
  const manifest = await loadLeaseManifest(ports, leaseId);
  const expectedResources = await expectedCredentialResources(ports, leaseId, manifest.manifest);
  const missing = (): Promise<readonly string[]> => missingCredentials(ports, leaseId, expectedResources);

  // One client per credential, derived from the credential's own fields, so a later
  // revoke or cleanup needs no run profile and mixed authorization servers just work.
  const vault = createCredentialVault((_resource, credential) => oauthClientFromCredential(credential), ports.clock, {
    secrets: ports.secrets,
    allowInsecureRequests: allowInsecureForClient,
  });

  const { privateKey } = await ports.keys.loadOrCreate();
  const receiptStore = ports.receipts(leaseId);
  const cleanup = {
    url: manifest.manifest.cleanup === null ? null : manifest.manifest.cleanup.hook.url,
  };
  const license = await licenseCollaborator(
    ports,
    leaseId,
    resolveAuthMode(manifest.manifest),
    manifest.manifest.spec_version,
    manifest.manifest.auth.hosted?.kid ?? "publisher",
  );
  const defaults = createDefaultTeardownSteps(receiptStore, privateKey, vault, license, cleanup, {
    expectedResources,
    secrets: ports.secrets,
  });

  const deps: TeardownDeps = {
    leaseStore: ports.leases,
    receiptStore,
    leaseId,
    steps: input.decorateSteps?.(defaults) ?? defaults,
    signingKey: privateKey,
    ...(ports.telemetry === undefined ? {} : { telemetry: ports.telemetry }),
    credentialCheck: { expected: expectedResources, missing },
    // Phase 9 D-09: every pass assembled here is fenced, with the runtime's own clock.
    fence: { clock: ports.clock, ttlSeconds: input.fenceTtlSeconds ?? DEFAULT_FENCE_TTL_SECONDS },
  };

  return {
    leaseId,
    manifest,
    expectedResources,
    deps,
    missingCredentials: missing,
    run: (now) => runTeardown(deps, now),
    retry: (actor, now) => retryTeardown(deps, actor, now),
  };
}
