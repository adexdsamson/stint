/**
 * The `SecretStore` port (RT-02). Holds the secret values a lease needs while
 * it is live (for example a minted upstream credential) so teardown can read
 * them back to revoke.
 *
 * Normative rules every implementation MUST meet:
 *
 * - Values are opaque strings. The port never inspects, parses or truncates one.
 * - A key is namespaced `lease/LEASE_ID/...`. Build keys with
 *   `credentialSecretKey` and prefixes with `leaseSecretPrefix`.
 * - The trailing slash of a prefix is a segment boundary: `deletePrefix("lease/a/")`
 *   never touches `lease/ab/...`.
 * - An implementation MUST validate every key with `assertValidSecretKey` and
 *   every prefix with `assertValidSecretPrefix` before touching its backend, so
 *   a hostile resource name can never escape its lease namespace.
 * - `put` on an existing key replaces the value; concurrent puts on one key
 *   leave exactly one of the written values, never a mix.
 * - There is deliberately NO enumeration method. OS keychains cannot list their
 *   entries, so the runtime always derives the keys it needs.
 */

/** Opaque secret storage addressed by a validated, lease-namespaced key. */
export interface SecretStore {
  /** The stored value, or `undefined` when the key is absent. */
  get(key: string): Promise<string | undefined>;
  /** Stores `value` under `key`, replacing any previous value. */
  put(key: string, value: string): Promise<void>;
  /** Removes `key`; resolves normally when it is already absent. */
  delete(key: string): Promise<void>;
  /** Removes every key under `prefix` (a segment boundary) and resolves the number removed. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Thrown for an invalid key or prefix. The message is fixed and never echoes the offending value. */
export class SecretKeyError extends Error {
  constructor() {
    super("Invalid secret key.");
    this.name = "SecretKeyError";
  }
}

const MAX_KEY_LENGTH = 1024;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 255;

function hasForbiddenCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function isValidKeyBody(key: string): boolean {
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) return false;
  const segments = key.split("/");
  if (segments.length < 1 || segments.length > MAX_SEGMENTS) return false;
  for (const segment of segments) {
    if (segment.length < 1 || segment.length > MAX_SEGMENT_LENGTH) return false;
    if (segment === "." || segment === "..") return false;
    if (hasForbiddenCharacter(segment)) return false;
  }
  return true;
}

/**
 * Throws `SecretKeyError` unless `key` is 1 to 1024 characters in 1 to 8
 * `/`-separated segments, each 1 to 255 characters, never `.` or `..`, with no
 * backslash, NUL or other control character.
 */
export function assertValidSecretKey(key: string): void {
  if (typeof key !== "string" || !isValidKeyBody(key)) throw new SecretKeyError();
}

/** Throws `SecretKeyError` unless `prefix` is a valid key followed by exactly one trailing `/`. */
export function assertValidSecretPrefix(prefix: string): void {
  if (typeof prefix !== "string" || !prefix.endsWith("/") || !isValidKeyBody(prefix.slice(0, -1))) {
    throw new SecretKeyError();
  }
}

function assertSingleSegment(leaseId: string): void {
  if (typeof leaseId !== "string" || leaseId.includes("/")) throw new SecretKeyError();
}

/** The prefix covering every secret of one lease: `lease/LEASE_ID/`. */
export function leaseSecretPrefix(leaseId: string): string {
  assertSingleSegment(leaseId);
  const prefix = `lease/${leaseId}/`;
  assertValidSecretPrefix(prefix);
  return prefix;
}

/** The key of one minted credential: `lease/LEASE_ID/cred/RESOURCE`. */
export function credentialSecretKey(leaseId: string, resource: string): string {
  assertSingleSegment(leaseId);
  const key = `lease/${leaseId}/cred/${resource}`;
  assertValidSecretKey(key);
  return key;
}
