/**
 * The publisher binding shape: the NON-SECRET runtime configuration a hosted or
 * hybrid lease needs to reach its publisher -- the license issue, reissue and
 * invalidate endpoints and the publisher's pinned license verification key (a
 * PASERK `k4.public.` string). It comes from the `--publisher` input given when
 * a lease is created, never from the manifest (spec section 8: endpoints are
 * runtime connector configuration), and a host persists it as the `publisher`
 * lease artifact.
 *
 * This module is the pure shape check; it reads no file. URLs must be `https:`
 * or loopback `http:` (the same rule the manifest schema applies to
 * `CleanupHook.url`).
 */

import { isLoopbackHttp } from "./loopback.js";

export interface PublisherBinding {
  readonly issue_url: string;
  readonly reissue_url: string;
  readonly invalidate_url: string;
  /** PASERK `k4.public.<base64url>`: the publisher's pinned license verification key. */
  readonly license_public_key: string;
}

const BINDING_KEYS = ["issue_url", "reissue_url", "invalidate_url", "license_public_key"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `https:` or loopback `http:` only; everything else (including unparseable) is refused. */
function isAllowedPublisherUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  return new URL(url).protocol === "https:" || isLoopbackHttp(url);
}

/** Structural validation (no key import). Returns a clean copy, or `undefined` for any malformed shape. */
export function parsePublisherBinding(raw: unknown): PublisherBinding | undefined {
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
