/**
 * The publisher binding persisted next to a lease
 * (`<root>/leases/<id>/publisher.json`): the NON-SECRET runtime configuration a
 * hosted or hybrid lease needs to reach its publisher -- the license issue,
 * reissue and invalidate endpoints and the publisher's pinned license
 * verification key (a PASERK `k4.public.` string). It comes from the
 * `--publisher <file>` given to `stint create`, never from the manifest (spec
 * section 8: endpoints are runtime connector configuration), and is persisted
 * so `run`/`revoke`/`cleanup` find it without further flags.
 *
 * URLs must be `https:` or loopback `http:` (the same rule the manifest schema
 * applies to `CleanupHook.url`). Every failure is a fixed-text `CliError`: file
 * contents, URLs and key material are never echoed.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { importLicensePublicKey } from "@stint/core/license-issuer";
import { parsePublisherBinding } from "@stint/runtime";
import type { PublisherBinding } from "@stint/runtime";

import { CliError, EXIT_CODES } from "../exit.js";
import { leaseDir } from "../paths.js";
import { atomicWriteJson, readJsonRetry } from "./atomic-file.js";

export type { PublisherBinding };

export function publisherBindingFile(root: string, leaseId: string): string {
  return path.join(leaseDir(root, leaseId), "publisher.json");
}

/**
 * Reads and validates the `--publisher` file, including that the key is a
 * well-formed `k4.public` PASERK. Throws `CliError(usage)` with a fixed message
 * on any failure.
 */
export async function parsePublisherBindingFile(file: string): Promise<PublisherBinding> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new CliError(EXIT_CODES.usage, "The publisher file could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The publisher file is not valid JSON.");
  }
  const binding = parsePublisherBinding(parsed);
  if (binding === undefined) {
    throw new CliError(EXIT_CODES.usage, "The publisher file has an unexpected shape.");
  }
  try {
    await importLicensePublicKey(binding.license_public_key);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The publisher file has an unexpected shape.");
  }
  return binding;
}

/** Persists the binding beside its lease (atomic write, like `envelope.json`). */
export async function savePublisherBinding(
  root: string,
  leaseId: string,
  binding: PublisherBinding,
): Promise<void> {
  await mkdir(leaseDir(root, leaseId), { recursive: true });
  await atomicWriteJson(publisherBindingFile(root, leaseId), binding);
}

/**
 * Loads the persisted binding. Resolves `undefined` when none was stored (a
 * delegated lease); a stored file that is no longer valid fails closed with a
 * fixed `storeCorrupt` error rather than being trusted.
 */
export async function loadPublisherBinding(
  root: string,
  leaseId: string,
): Promise<PublisherBinding | undefined> {
  const raw = await readJsonRetry(publisherBindingFile(root, leaseId));
  if (raw === undefined) return undefined;
  const binding = parsePublisherBinding(raw);
  if (binding === undefined) {
    throw new CliError(EXIT_CODES.storeCorrupt, "The stored publisher binding is invalid.");
  }
  return binding;
}
