/**
 * Publisher trust store (A4, deny-by-default). Maps publisherId -> kid ->
 * Ed25519 public JWK, read from `<root>/trust.json` or an explicit `--trust`
 * file. A missing or empty file yields an EMPTY store, so any publisher is
 * unknown and `verifyEnvelope` fails closed.
 *
 * Only well-formed `{kty:"OKP", crv:"Ed25519", x}` entries are kept; anything
 * else (including a stray private `d` member) is dropped, never trusted.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Ed25519PublicJwk, TrustStore } from "@stint/spec";

import { CliError, EXIT_CODES } from "../exit.js";

export interface TrustStoreOptions {
  /** Explicit trust file (`--trust <file>`); overrides `<root>/trust.json`. */
  readonly trust?: string | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readKey(raw: unknown): Ed25519PublicJwk | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kty !== "OKP" || raw.crv !== "Ed25519" || typeof raw.x !== "string") return undefined;
  return { kty: "OKP", crv: "Ed25519", x: raw.x };
}

export async function loadTrustStore(
  root: string,
  opts: TrustStoreOptions = {},
): Promise<TrustStore> {
  const file =
    opts.trust !== undefined && opts.trust !== "" ? opts.trust : path.join(root, "trust.json");

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return {}; // absent/unreadable: empty store, fails closed
  }
  if (text.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The trust file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new CliError(EXIT_CODES.usage, "The trust file has an unexpected shape.");
  }

  const store: Record<string, Record<string, Ed25519PublicJwk>> = {};
  for (const [publisherId, kids] of Object.entries(parsed)) {
    if (!isRecord(kids)) continue;
    const entries: Array<[string, Ed25519PublicJwk]> = [];
    for (const [kid, jwk] of Object.entries(kids)) {
      const key = readKey(jwk);
      if (key !== undefined) entries.push([kid, key]);
    }
    if (entries.length > 0) {
      Object.defineProperty(store, publisherId, {
        value: Object.fromEntries(entries),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return store;
}
