/**
 * Shared wiring for `revoke` and `cleanup`. Both are thin drivers over the
 * Phase-5 teardown orchestrator: this file only assembles its inputs (a REAL
 * credential vault, the runtime signing key, the manifest's cleanup hook) and
 * reports its result. There is no teardown logic here.
 *
 * The vault matters: `createDefaultTeardownSteps` called without one swaps in
 * a happy-path placeholder that would receipt a false `revoked`. With a real
 * vault, `revoke_oauth` records what actually happened (`revoked`,
 * `discarded_revocation_unsupported` or `failed`) or `not_applicable` when the
 * vault holds nothing. Credentials live only in that in-memory vault; they are
 * never stored, receipted or printed.
 */

import { resolveAuthMode } from "@stint/spec";
import type { Lease } from "@stint/core";
import { createCredentialVault, createDefaultTeardownSteps } from "@stint/proxy";
import type { OAuthClient, TeardownDeps } from "@stint/proxy";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import type { LoadedCredential } from "../run/credentials.js";
import { isLoopbackHttp } from "../run/loopback.js";
import { loadStoredManifest } from "../store/envelope.js";

export interface TeardownCommandOpts extends GlobalOpts {
  readonly yes?: boolean | undefined;
  readonly credentials?: string | undefined;
}

/** Placeholder identity for a vault that holds no credential; never used on the wire. */
const NO_CREDENTIAL_CLIENT: OAuthClient = {
  as: { issuer: "https://stint.invalid", token_endpoint: "https://stint.invalid/token" },
  client: { client_id: "stint" },
  clientAuth: (_as, client, body) => {
    body.set("client_id", client.client_id);
  },
};

/**
 * Builds the OAuth client the vault uses to revoke, from the non-secret AS
 * details in the credentials file. The vault holds one client, so a file that
 * mixes authorization servers is refused up front rather than revoked against
 * the wrong one. Without a `revocationEndpoint` the resulting receipt is
 * honestly `discarded_revocation_unsupported`.
 */
function oauthClientFor(creds: Readonly<Record<string, LoadedCredential>>): OAuthClient {
  const distinct = new Map<string, LoadedCredential>();
  for (const cred of Object.values(creds)) {
    const key = JSON.stringify([cred.tokenEndpoint, cred.revocationEndpoint, cred.clientId]);
    distinct.set(key, cred);
  }
  if (distinct.size === 0) return NO_CREDENTIAL_CLIENT;
  if (distinct.size > 1) {
    throw new CliError(
      EXIT_CODES.usage,
      "The credentials file mixes authorization servers; revoke and cleanup support one.",
    );
  }
  const [only] = [...distinct.values()];
  if (only === undefined) return NO_CREDENTIAL_CLIENT;
  return {
    as: {
      issuer: new URL(only.tokenEndpoint).origin,
      token_endpoint: only.tokenEndpoint,
      ...(only.revocationEndpoint === undefined
        ? {}
        : { revocation_endpoint: only.revocationEndpoint }),
    },
    client: { client_id: only.clientId ?? "stint" },
    // RFC 6749 public client: identify by client_id only.
    clientAuth: (_as, client, body) => {
      body.set("client_id", client.client_id);
    },
  };
}

/**
 * Whether the vault may speak plain http (D-16). Derived from the ONE
 * authorization server the credentials name, never a blanket switch: true only
 * when at least one of its endpoints is loopback http AND every endpoint is
 * either https or loopback http. A non-loopback http endpoint anywhere keeps
 * the HTTPS-only guard fully on.
 */
function allowInsecureFor(client: OAuthClient): boolean {
  const endpoints = [client.as.token_endpoint, client.as.revocation_endpoint].filter(
    (url): url is string => url !== undefined,
  );
  const secureOrLoopback = endpoints.every(
    (url) => isLoopbackHttp(url) || (URL.canParse(url) && new URL(url).protocol === "https:"),
  );
  return secureOrLoopback && endpoints.some((url) => isLoopbackHttp(url));
}

/**
 * Assembles `TeardownDeps` for one lease. `needsCredentials` is true whenever
 * `revoke_oauth` has yet to run: for a delegated or hybrid lease the credentials file is
 * then required, so that step cannot silently report nothing to revoke.
 */
export async function buildTeardownDeps(
  deps: CliDeps,
  root: string,
  leaseId: string,
  opts: TeardownCommandOpts,
  needsCredentials: boolean,
): Promise<TeardownDeps> {
  const verified = await loadStoredManifest(deps, root, leaseId);
  // Hybrid carries `auth.delegated` grants too; only a purely hosted lease has none.
  const hasOAuthGrants = resolveAuthMode(verified.manifest) !== "hosted";
  const credentialsFile =
    opts.credentials === undefined || opts.credentials === "" ? undefined : opts.credentials;

  if (hasOAuthGrants && needsCredentials && credentialsFile === undefined) {
    throw new CliError(
      EXIT_CODES.usage,
      "--credentials <file> is required so the lease's OAuth grants can be revoked.",
    );
  }

  const credentials =
    hasOAuthGrants && credentialsFile !== undefined
      ? await deps.credentials.load(credentialsFile)
      : undefined;
  const oauthClient =
    credentials === undefined ? NO_CREDENTIAL_CLIENT : oauthClientFor(credentials);
  const vault = createCredentialVault(
    oauthClient,
    deps.clock,
    allowInsecureFor(oauthClient) ? { allowInsecureRequests: true } : {},
  );
  if (credentials !== undefined) deps.credentials.seedVault(vault, leaseId, credentials);

  const { privateKey } = await deps.keys.loadOrCreate(root);
  const receiptStore = deps.receiptStoreFactory(root, leaseId);
  const cleanup = {
    url: verified.manifest.cleanup === null ? null : verified.manifest.cleanup.hook.url,
  };
  const defaults = createDefaultTeardownSteps(receiptStore, privateKey, vault, undefined, cleanup);

  return {
    leaseStore: deps.storeFactory(root),
    receiptStore,
    leaseId,
    steps: deps.teardown?.decorateSteps?.(defaults) ?? defaults,
    signingKey: privateKey,
  };
}

/**
 * The `[y/N]` gate before a destructive action. Returns an exit code when the
 * user declined (nothing changed), or `undefined` to proceed. With no terminal
 * and no `--yes` it refuses, so consent is never assumed.
 */
export async function confirmOrDecline(
  deps: CliDeps,
  question: string,
  yes: boolean | undefined,
): Promise<number | undefined> {
  if (yes === true) return undefined;
  const answer = await deps.confirm?.(question);
  if (answer === undefined) {
    throw new CliError(
      EXIT_CODES.usage,
      "No interactive terminal is available to confirm; pass --yes to proceed.",
    );
  }
  if (!answer) {
    deps.io.err("stint: Aborted; nothing was changed.\n");
    return EXIT_CODES.consentDeclined;
  }
  return undefined;
}

/** Prints the resulting state and points at the signed trail; maps it to an exit code. */
export function reportTeardown(
  deps: CliDeps,
  opts: GlobalOpts,
  lease: Lease,
  extra: Readonly<Record<string, unknown>> = {},
): number {
  const done = lease.state === "cleaned_up";
  const incomplete = lease.state === "cleanup_incomplete";
  if (!done && !incomplete) {
    throw new CliError(EXIT_CODES.internal, "Internal error.");
  }
  const progress = lease.teardownProgress ?? {};

  if (opts.json === true) {
    deps.io.out(
      `${JSON.stringify({ leaseId: lease.id, state: lease.state, teardown: progress, ...extra })}\n`,
    );
  } else {
    deps.io.out(`Lease ${lease.id}: ${lease.state}\n`);
    for (const [step, outcome] of Object.entries(progress)) {
      deps.io.out(`  ${step}: ${outcome}\n`);
    }
    if (incomplete) {
      deps.io.err(
        `stint: Teardown did not finish. Run "stint cleanup ${lease.id}" to resume it.\n`,
      );
    }
    deps.io.err(
      `stint: See the signed per-step trail with "stint receipts ${lease.id}" and "stint verify ${lease.id}".\n`,
    );
  }
  return done ? EXIT_CODES.ok : EXIT_CODES.cleanupIncomplete;
}
