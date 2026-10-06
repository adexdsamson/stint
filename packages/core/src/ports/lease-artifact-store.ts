/**
 * The `LeaseArtifactStore` port (RT-02). Per-lease, non-secret, JSON-serialisable
 * artifacts: the signed envelope, the publisher binding and the recorded grant
 * manifest.
 *
 * A secret MUST NOT be stored through this port; secrets go to `SecretStore`.
 * The `grants` artifact records which credentials the lease expects (names and
 * kinds only) so teardown can fail closed when a credential is unavailable.
 */

/**
 * The artifacts a lease carries. `run_heartbeat` is written lock-free by a live
 * `run` every few seconds so a supervisor can tell a run is serving the lease
 * and must not refresh its grant (Phase 9 D-18). It holds timestamps only.
 */
export type LeaseArtifactName = "envelope" | "publisher" | "grants" | "run_heartbeat";

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

/**
 * The live-run heartbeat (D-18). `beatAt` is the last time a run proved it is
 * alive, in whole epoch seconds; `endedAt` is set when the run ended cleanly.
 * No secret, no identifier beyond the lease it is stored under.
 */
export interface RunHeartbeat {
  readonly v: 1;
  readonly beatAt: number;
  readonly endedAt?: number;
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Strictly validates a stored `run_heartbeat` artifact. Returns `undefined` for
 * a wrong version, a missing or non-integer or negative `beatAt` or `endedAt`,
 * and a non-object, so a caller can treat anything it does not recognise as a
 * live run (probing next to a live run is the dangerous direction).
 */
export function parseRunHeartbeat(raw: unknown): RunHeartbeat | undefined {
  if (!isRecord(raw) || raw.v !== 1 || !isEpochSeconds(raw.beatAt)) return undefined;
  if (raw.endedAt === undefined) return { v: 1, beatAt: raw.beatAt };
  if (!isEpochSeconds(raw.endedAt)) return undefined;
  return { v: 1, beatAt: raw.beatAt, endedAt: raw.endedAt };
}
