/**
 * Shared credentials-file parser and vault seeder (D-02, A5), used by
 * run/revoke/cleanup. The file holds SECRETS (access/refresh tokens): its
 * contents go only into the in-memory vault and are never persisted to the
 * store or receipts, and never echoed in an error. No OAuth acquisition flow
 * lives here (D-02).
 *
 * File shape: `{ "<resource>": { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator } }`.
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

function parseSeeded(raw: unknown): SeededCredential | undefined {
  if (!isRecord(raw)) return undefined;
  const { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator } = raw;
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
  return { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator };
}

/** Parses the credentials file. Throws `CliError(usage)` with a fixed message on any malformed shape. */
export async function loadCredentials(file: string): Promise<Record<string, SeededCredential>> {
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

  const entries: Array<[string, SeededCredential]> = [];
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
  for (const [resource, seeded] of Object.entries(creds)) {
    vault.seedCredential(leaseId, resource, seeded);
  }
}
