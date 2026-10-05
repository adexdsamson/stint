/**
 * The `LeaseArtifactStore` port (RT-02). Per-lease, non-secret, JSON-serialisable
 * artifacts: the signed envelope, the publisher binding and the recorded grant
 * manifest.
 *
 * A secret MUST NOT be stored through this port; secrets go to `SecretStore`.
 * The `grants` artifact records which credentials the lease expects (names and
 * kinds only) so teardown can fail closed when a credential is unavailable.
 */

/** The three artifacts a lease carries. */
export type LeaseArtifactName = "envelope" | "publisher" | "grants";

/** Per-lease artifact storage. */
export interface LeaseArtifactStore {
  /** The stored value, or `undefined` when the artifact is absent. */
  get(leaseId: string, name: LeaseArtifactName): Promise<unknown>;
  /** Stores `value` for `(leaseId, name)`, replacing any previous value. */
  put(leaseId: string, name: LeaseArtifactName, value: unknown): Promise<void>;
}

/** One credential a lease expects to hold. Names and kinds only, never a value. */
export interface GrantRecord {
  readonly resource: string;
  readonly kind: "oauth" | "api_key";
  readonly revocation?: "supported" | "unsupported";
}

/** The recorded grant manifest. */
export interface GrantsArtifact {
  readonly version: 1;
  readonly grants: readonly GrantRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrant(raw: unknown): GrantRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const { resource, kind, revocation } = raw;
  if (typeof resource !== "string" || resource.length === 0) return undefined;
  if (kind !== "oauth" && kind !== "api_key") return undefined;
  if (revocation === undefined) return { resource, kind };
  if (revocation !== "supported" && revocation !== "unsupported") return undefined;
  return { resource, kind, revocation };
}

/**
 * Strictly validates a stored `grants` artifact. Returns `undefined` for a wrong
 * version, a non-array `grants`, an unknown kind, an empty resource or a
 * non-object, so a caller can fail closed on anything it does not recognise.
 */
export function parseGrantsArtifact(raw: unknown): GrantsArtifact | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.grants)) return undefined;
  const grants: GrantRecord[] = [];
  for (const entry of raw.grants as unknown[]) {
    const grant = parseGrant(entry);
    if (grant === undefined) return undefined;
    grants.push(grant);
  }
  return { version: 1, grants };
}
