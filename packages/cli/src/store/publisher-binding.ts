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

import { CliError, EXIT_CODES } from "../exit.js";
import { leaseDir } from "../paths.js";
import { isLoopbackHttp } from "../run/loopback.js";
import { atomicWriteJson, readJsonRetry } from "./atomic-file.js";

export interface PublisherBinding {
  readonly issue_url: string;
  readonly reissue_url: string;
  readonly invalidate_url: string;
  /** PASERK `k4.public.<base64url>`: the publisher's pinned license verification key. */
  readonly license_public_key: string;
}

const BINDING_KEYS = ["issue_url", "reissue_url", "invalidate_url", "license_public_key"] as const;

export function publisherBindingFile(root: string, leaseId: string): string {
  return path.join(leaseDir(root, leaseId), "publisher.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `https:` or loopback `http:` only; everything else (including unparseable) is refused. */
function isAllowedPublisherUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  return new URL(url).protocol === "https:" || isLoopbackHttp(url);
}

/** Structural validation (no key import). Returns a clean copy, or `undefined` for any malformed shape. */
function shapeOf(raw: unknown): PublisherBinding | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of BINDING_KEYS) {
    const value = raw[key];
    if (typeof value !== "string" || value === "") return undefined;
  }
  const { issue_url, reissue_url, invalidate_url, license_public_key } = raw as Record<
    (typeof BINDING_KEYS)[number],
    string
  >;
  if (![issue_url, reissue_url, invalidate_url].every(isAllowedPublisherUrl)) return undefined;
  if (!license_public_key.startsWith("k4.public.")) return undefined;
  return { issue_url, reissue_url, invalidate_url, license_public_key };
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
  const binding = shapeOf(parsed);
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
  const binding = shapeOf(raw);
  if (binding === undefined) {
    throw new CliError(EXIT_CODES.storeCorrupt, "The stored publisher binding is invalid.");
  }
  return binding;
}
