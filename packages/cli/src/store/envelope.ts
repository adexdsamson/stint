/**
 * The signed manifest envelope persisted next to a lease
 * (`<root>/leases/<id>/envelope.json`). A `Lease` carries only the bound
 * content hash, so any later command that needs the manifest (`run` for scopes,
 * limits and approvals, `revoke`/`cleanup` for auth mode and the cleanup hook)
 * re-reads this file and RE-VERIFIES it against the trust store; the stored
 * bytes are never trusted on their own.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseEnvelope, verifyEnvelope } from "@stint/spec";
import type { VerifiedManifest } from "@stint/spec";

import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { leaseDir } from "../paths.js";
import { atomicWriteJson, withTransientRetry } from "./atomic-file.js";

export function envelopeFile(root: string, leaseId: string): string {
  return path.join(leaseDir(root, leaseId), "envelope.json");
}

/** Persists the parsed signed envelope beside its lease (atomic write). */
export async function saveEnvelope(
  root: string,
  leaseId: string,
  envelope: unknown,
): Promise<void> {
  await mkdir(leaseDir(root, leaseId), { recursive: true });
  await atomicWriteJson(envelopeFile(root, leaseId), envelope);
}

/**
 * Reads the stored envelope and verifies it against the trust store, so a
 * tampered file or a publisher that is no longer trusted fails closed. Every
 * failure is a fixed-text `CliError`; verification detail never reaches output.
 */
export async function loadStoredManifest(
  deps: Pick<CliDeps, "loadTrustStore">,
  root: string,
  leaseId: string,
): Promise<VerifiedManifest> {
  let bytes: Uint8Array;
  try {
    bytes = await withTransientRetry(() => readFile(envelopeFile(root, leaseId)));
  } catch {
    throw new CliError(EXIT_CODES.manifestInvalid, "The lease has no stored manifest.");
  }
  const parsed = parseEnvelope(bytes);
  if (!parsed.ok) {
    throw new CliError(EXIT_CODES.manifestInvalid, "The stored manifest could not be parsed.");
  }
  const trust = await deps.loadTrustStore(root, {});
  const verified = await verifyEnvelope(parsed.value, trust);
  if (!verified.ok) {
    const reason = verified.errors[0]?.code ?? "invalid_signature";
    throw new CliError(
      EXIT_CODES.manifestInvalid,
      `The stored manifest failed verification (${reason}).`,
    );
  }
  return verified.value;
}
