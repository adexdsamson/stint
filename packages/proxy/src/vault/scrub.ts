/**
 * `scrubCredential`/`scrubError` -- the narrow credential-scrubbing boundary
 * (D-02, PRXY-06, LIC-05). Mirrors `@stint/core/license/held-license.ts`'s
 * "never expose raw secret material by default" discipline, but applied as
 * a transform rather than an opaque-handle custody type: `vault/execute-
 * stage.ts` wraps every `OutboundConnector.execute(...)` call in these two
 * functions so the exact known secret value(s) the vault just resolved
 * cannot survive into a returned value or a thrown error that crosses back
 * toward the agent-facing boundary.
 *
 * Deliberately NOT a generic secret-shaped regex (`## Don't Hand-Roll`,
 * 04-RESEARCH.md): a generic scanner produces both false negatives (a token
 * shaped differently than expected) and false positives. This scrubber only
 * ever strips the EXACT known string(s) passed in -- the vault always knows
 * the precise value because it just resolved it.
 */

const REDACTION_MARKER = "[redacted]";

function scrubString(value: string, knownSecrets: readonly string[]): string {
  let result = value;
  for (const secret of knownSecrets) {
    if (secret.length === 0) continue;
    result = result.split(secret).join(REDACTION_MARKER);
  }
  return result;
}

function scrubUnknown(value: unknown, knownSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return scrubString(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => scrubUnknown(item, knownSecrets));
  }
  if (value !== null && typeof value === "object") {
    const objValue = value as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(objValue)) {
      scrubbed[key] = scrubUnknown(entryValue, knownSecrets);
    }
    return scrubbed;
  }
  return value;
}

/**
 * Strips every exact occurrence of each `knownSecrets` string from `value`,
 * walking strings, arrays, and plain objects recursively and replacing any
 * matched substring with a fixed, non-secret redaction marker. Numbers,
 * booleans, `null`, and `undefined` pass through unchanged. Never a generic
 * secret-shaped pattern match -- only the exact values supplied.
 */
export function scrubCredential<T>(value: T, knownSecrets: readonly string[]): T {
  return scrubUnknown(value, knownSecrets) as T;
}

/**
 * Returns a NEW `Error` with `knownSecrets` stripped from `message`,
 * `stack`, and every other own property the original error carries (e.g. a
 * `cause`/`body` an adversarial connector attached to leak its credential
 * via a thrown error). The original error object -- and any secret it
 * carries -- is never returned or mutated in place; `err` itself is never
 * exposed past this function.
 */
export function scrubError(err: unknown, knownSecrets: readonly string[]): Error {
  const original = err instanceof Error ? err : new Error(scrubString(String(err), knownSecrets));

  const scrubbed = new Error(scrubString(original.message, knownSecrets));
  scrubbed.name = original.name;
  if (original.stack !== undefined) {
    scrubbed.stack = scrubString(original.stack, knownSecrets);
  }

  const scrubbedRecord = scrubbed as unknown as Record<string, unknown>;
  const originalRecord = original as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(original)) {
    if (key === "message" || key === "stack" || key === "name") continue;
    scrubbedRecord[key] = scrubUnknown(originalRecord[key], knownSecrets);
  }

  return scrubbed;
}
