/**
 * PASERK `k4.public` import/export for the publisher's pinned license key.
 *
 * The runtime learns the publisher's verification key from non-secret
 * configuration (a `k4.public.<base64url>` PASERK string), never from the
 * manifest. These two helpers keep `paseto` itself out of the CLI's dependency
 * list: the CLI imports the string form, hands the `PublicKey` to
 * `createLicenseIssuerClient`, and a publisher (or a test harness) exports the
 * string form of the key it signs with. Only PUBLIC key material crosses this
 * module; no secret key is ever imported or exported here.
 *
 * Both helpers throw a fixed-message error on malformed input: paseto's own
 * error text is never forwarded.
 */

import { PublicProtocol } from "paseto";
import { ExportPublicKeyFactory, ImportPublicKeyFactory } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";

const importProtocol = new PublicProtocol(ImportPublicKeyFactory);
const exportProtocol = new PublicProtocol(ExportPublicKeyFactory);

const PUBLIC_PASERK_PREFIX = "k4.public.";

/** Whether `value` has the `k4.public.` PASERK shape (a cheap pre-check; import is the real validation). */
export function isPublicPaserk(value: string): value is `k4.public.${string}` {
  return value.startsWith(PUBLIC_PASERK_PREFIX) && value.length > PUBLIC_PASERK_PREFIX.length;
}

/** Imports a `k4.public.` PASERK string as a pinned verification key. Throws a fixed message on any malformed input. */
export async function importLicensePublicKey(paserk: string): Promise<PublicKey> {
  if (!isPublicPaserk(paserk)) throw new Error("The license public key is not a valid PASERK.");
  try {
    return await importProtocol.ImportPublicKey(paserk);
  } catch {
    throw new Error("The license public key is not a valid PASERK.");
  }
}

/** Exports a verification key as its `k4.public.` PASERK string (what a publisher shares with runtimes). */
export function exportLicensePublicKey(publicKey: PublicKey): Promise<string> {
  return exportProtocol.ExportPublicKey(publicKey);
}
