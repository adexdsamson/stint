/**
 * Shared credentials-file parser and vault seeder (D-02, A5), used by
 * run/revoke/cleanup. The file holds SECRETS (access/refresh tokens): its
 * contents go only into the in-memory vault and are never persisted to the
 * store or receipts, and never echoed in an error. No OAuth acquisition flow
 * lives here (D-02).
 *
 * File shape: `{ "<resource>": { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator,
 * clientId?, revocationEndpoint? } }`. `clientId` and `revocationEndpoint` are the non-secret
 * authorization-server details `revoke`/`cleanup` need to attempt RFC 7009 revocation (they have
 * no run profile): `revocationEndpoint` requires `clientId`, and without it revocation is
 * honestly receipted as `discarded_revocation_unsupported`.
 */

import { readFile } from "node:fs/promises";

import type { CredentialVault, SeededCredential } from "@stint/proxy";

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

/** A seeded credential plus the optional non-secret AS details used only to attempt revocation. */
export interface LoadedCredential extends SeededCredential {
  readonly clientId?: string;
  readonly revocationEndpoint?: string;
}

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
  creds: Readonly<Record<string, LoadedCredential>>,
): void {
  for (const [resource, loaded] of Object.entries(creds)) {
    // Only the vault's own shape goes in; the AS details are used to build the revocation client.
    const { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator } = loaded;
    vault.seedCredential(leaseId, resource, {
      accessToken,
      refreshToken,
      expiry,
      tokenEndpoint,
      resourceIndicator,
    });
  }
}
