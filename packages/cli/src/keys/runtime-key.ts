/**
 * The runtime's Ed25519 checkpoint-signing key (A4, flagged assumption).
 *
 * Layout under the store root:
 *   `<root>/keys/runtime-ed25519.json`      private JWK (0600 where the OS honors it)
 *   `<root>/keys/runtime-ed25519.pub.json`  public JWK, read by `verify`
 *
 * Key bytes are never logged and never appear in an error message. All crypto
 * is `jose` (no hand-rolled crypto, CLAUDE.md).
 */

import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from "jose";
import type { CryptoKey, JWK } from "jose";

import { CliError, EXIT_CODES } from "../exit.js";
import { StoreCorruptError, atomicWriteJson, readJsonRetry } from "../store/atomic-file.js";

const PRIVATE_FILE = "runtime-ed25519.json";
const PUBLIC_FILE = "runtime-ed25519.pub.json";

/** Public half in its minimal JWK form (never carries `d`). */
export interface RuntimePublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

/** The loaded runtime key pair. `kid` is the RFC 7638 thumbprint of the public key. */
export interface RuntimeKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicJwk: RuntimePublicJwk;
  readonly kid: string;
}

function keysDir(root: string): string {
  return path.join(root, "keys");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extracts `{kty, crv, x}` from a JWK-shaped value, or `undefined` if it is not an Ed25519 OKP key. */
function readPublicJwk(raw: unknown): RuntimePublicJwk | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kty !== "OKP" || raw.crv !== "Ed25519" || typeof raw.x !== "string") return undefined;
  return { kty: "OKP", crv: "Ed25519", x: raw.x };
}

/** True when `raw` is an Ed25519 private JWK (has a string `d` alongside a valid public half). */
function isPrivateJwk(raw: unknown): raw is Record<string, unknown> & { d: string } {
  return readPublicJwk(raw) !== undefined && isRecord(raw) && typeof raw.d === "string";
}

/** Imports an Ed25519 JWK as a `CryptoKey`; any failure is corruption (fixed message, no key bytes). */
async function importEd25519(jwk: JWK): Promise<CryptoKey> {
  try {
    const key = await importJWK(jwk, "EdDSA");
    if (key instanceof Uint8Array) throw new StoreCorruptError();
    return key;
  } catch {
    throw new StoreCorruptError();
  }
}

async function bestEffortChmod(file: string): Promise<void> {
  try {
    await chmod(file, 0o600);
  } catch {
    // win32 and some filesystems do not honor POSIX modes; the key is still only in the user's store.
  }
}

/**
 * Loads `<root>/keys/runtime-ed25519.json`, or generates and persists a fresh
 * Ed25519 key pair on first use. The public JWK is (re)written next to it if
 * missing so `verify` can always load it.
 */
export async function loadOrCreateRuntimeKey(root: string): Promise<RuntimeKey> {
  const dir = keysDir(root);
  const privateFile = path.join(dir, PRIVATE_FILE);
  const publicFile = path.join(dir, PUBLIC_FILE);

  const existing = await readJsonRetry(privateFile);
  if (existing !== undefined) {
    if (!isPrivateJwk(existing)) throw new StoreCorruptError();
    const publicJwk = readPublicJwk(existing);
    if (publicJwk === undefined) throw new StoreCorruptError();
    const privateKey = await importEd25519(existing);
    const publicKey = await importEd25519(publicJwk);
    if ((await readJsonRetry(publicFile)) === undefined) {
      await atomicWriteJson(publicFile, publicJwk);
    }
    await bestEffortChmod(privateFile);
    return { privateKey, publicKey, publicJwk, kid: await calculateJwkThumbprint(publicJwk) };
  }

  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = readPublicJwk(await exportJWK(pair.publicKey));
  if (publicJwk === undefined) {
    throw new CliError(EXIT_CODES.internal, "Could not generate the runtime signing key.");
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWriteJson(privateFile, privateJwk);
  await bestEffortChmod(privateFile);
  await atomicWriteJson(publicFile, publicJwk);

  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    kid: await calculateJwkThumbprint(publicJwk),
  };
}

/** Loads the runtime checkpoint PUBLIC key for `verify`. Never reads the private file. */
export async function loadCheckpointPublicKey(root: string): Promise<RuntimeKey["publicKey"]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(keysDir(root), PUBLIC_FILE), "utf8")) as unknown;
  } catch {
    throw new CliError(
      EXIT_CODES.internal,
      "The runtime public key was not found; run `stint create` first.",
    );
  }
  const publicJwk = readPublicJwk(raw);
  if (publicJwk === undefined) throw new StoreCorruptError();
  return await importEd25519(publicJwk);
}
