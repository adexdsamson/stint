/**
 * Shared credentials-file parser and vault seeder (D-02, A5), used by
 * run/revoke/cleanup. The file holds SECRETS (access/refresh tokens): its
 * contents go into the vault, never into receipts, and are never echoed in an
 * error. This module never persists them: durable storage is the SecretStore's
 * job and is wired in plan 08-09. No OAuth acquisition flow lives here (D-02).
 *
 * File shape: `{ "<resource>": { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator,
 * clientId?, revocationEndpoint? } }`. `clientId` and `revocationEndpoint` are the non-secret
 * authorization-server details `revoke`/`cleanup` need to attempt RFC 7009 revocation (they have
 * no run profile): `revocationEndpoint` requires `clientId`, and without it revocation is
 * honestly receipted as `discarded_revocation_unsupported`.
 */

import { readFile } from "node:fs/promises";

import type { CredentialVault, OAuthSeededCredential, SeededCredential } from "@stint/proxy";

import { CliError, EXIT_CODES } from "../exit.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function isUrl(v: string): boolean {
  return URL.canParse(v);
}

/** A seeded OAuth grant plus the optional non-secret AS details used to build its per-credential revocation client. */
export type LoadedCredential = OAuthSeededCredential;

function parseSeeded(raw: unknown): LoadedCredential | undefined {
  if (!isRecord(raw)) return undefined;
  const { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator } = raw;
  const { clientId, revocationEndpoint } = raw;
  if (
    !isNonEmptyString(accessToken) ||
    !isNonEmptyString(refreshToken) ||
    typeof expiry !== "number" ||
    !Number.isFinite(expiry) ||
    !isNonEmptyString(tokenEndpoint) ||
    !isUrl(tokenEndpoint) ||
    !isNonEmptyString(resourceIndicator)
  ) {
    return undefined;
  }
  if (clientId !== undefined && !isNonEmptyString(clientId)) return undefined;
  if (
    revocationEndpoint !== undefined &&
    (!isNonEmptyString(revocationEndpoint) || !isUrl(revocationEndpoint) || clientId === undefined)
  ) {
    return undefined;
  }
  return {
    accessToken,
    refreshToken,
    expiry,
    tokenEndpoint,
    resourceIndicator,
    ...(clientId === undefined ? {} : { clientId }),
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
  };
}

/** Parses the credentials file. Throws `CliError(usage)` with a fixed message on any malformed shape. */
export async function loadCredentials(file: string): Promise<Record<string, LoadedCredential>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new CliError(EXIT_CODES.usage, "The credentials file could not be read.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The credentials file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new CliError(EXIT_CODES.usage, "The credentials file has an unexpected shape.");
  }

  const entries: Array<[string, LoadedCredential]> = [];
  for (const [resource, value] of Object.entries(parsed)) {
    const seeded = parseSeeded(value);
    if (seeded === undefined) {
      throw new CliError(EXIT_CODES.usage, "The credentials file has an unexpected shape.");
    }
    entries.push([resource, seeded]);
  }
  return Object.fromEntries(entries);
}

/** Feeds the Phase-4 vault seed seam from a parsed credentials map (in-memory only). */
export function seedVaultFromCredentials(
  vault: CredentialVault,
  leaseId: string,
  creds: Readonly<Record<string, SeededCredential>>,
): void {
  for (const [resource, credential] of Object.entries(creds)) {
    // The entry goes in as its own fields (including the non-secret clientId and
    // revocationEndpoint when present) so the vault can build a client per credential.
    // No `kind` is added: an entry without one is an OAuth grant.
    vault.seedCredential(leaseId, resource, { ...credential });
  }
}
