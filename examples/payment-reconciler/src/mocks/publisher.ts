/**
 * The mock publisher (D-07, D-10): a loopback `node:http` server on
 * `127.0.0.1:0` that stands in for the agent publisher's backend.
 *
 * - `POST /license/issue | /license/reissue | /license/invalidate` speak the
 *   CLI's publisher wire protocol (`packages/cli/src/run/license-http.ts`):
 *   the reference PASETO v4.public issuer signs with the `now`/`exp` the runtime
 *   sends, so a shared runtime clock and the publisher always agree (Pitfall 7).
 *   Only this boundary ever emits the raw token; the runtime-side client
 *   verifies it before trusting it.
 * - `POST /alp/cleanup` is the manifest's `cleanup.hook.url` (spec section 10):
 *   it verifies the runtime-minted EdDSA bearer with `verifyCleanupToken`,
 *   binds it to a known lease via its `cleanup:<lease_id>` scope, rejects a
 *   replayed `jti` (single use), and fails exactly once when
 *   `failNextCleanup()` is armed (D-10 partial-teardown injection).
 *
 * It imports `@stint/core/license-issuer` (vitest-free), never
 * `@stint/core/testing` (Pitfall 5). Always `stop()` it.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { LicenseClaims } from "@stint/core";
import { readLicenseToken } from "@stint/core";
import { createReferenceLicenseIssuer, exportLicensePublicKey } from "@stint/core/license-issuer";
import { verifyCleanupToken } from "@stint/proxy";
import type { CryptoKey } from "jose";

/** Options for {@link startMockPublisher}. */
export interface MockPublisherOptions {
  /**
   * Epoch-seconds clock used to evaluate the cleanup token's `exp`; share the
   * runtime's clock. Defaults to wall-clock time.
   */
  readonly now?: () => number;
  /** The runtime's checkpoint PUBLIC key (from `deps.keys.loadPublic` after `create`). Can also be set later. */
  readonly runtimePublicKey?: CryptoKey;
}

/** A running mock publisher and its observation/toggle surface. */
export interface MockPublisher {
  readonly baseUrl: string;
  readonly issueUrl: string;
  readonly reissueUrl: string;
  readonly invalidateUrl: string;
  readonly cleanupUrl: string;
  /** The publisher's license verification key as a `k4.public.` PASERK string (non-secret). */
  readonly licensePublicKeyPaserk: string;
  readonly issueHits: number;
  readonly reissueHits: number;
  readonly invalidateHits: number;
  /** Every `POST /alp/cleanup` received, whatever its outcome. */
  readonly cleanupHits: number;
  /** The `jti` of every cleanup token accepted (200) so far; a replay of one of these is refused 409. */
  readonly seenJtis: readonly string[];
  /** Every lease id the publisher was asked to invalidate. */
  readonly invalidatedLeaseIds: readonly string[];
  /** The raw licenses handed out (tests assert they never reach any other server). */
  readonly issuedTokens: readonly string[];
  /** Pins the runtime key used to verify cleanup bearers (available only after `stint create`). */
  setRuntimePublicKey(key: CryptoKey): void;
  /** Arms a ONE-SHOT 500 on the next otherwise-valid `/alp/cleanup` call (D-10). */
  failNextCleanup(): void;
  /** The reissue endpoint answers `{ license: null }` (the publisher refuses to refresh). */
  declineReissue(decline: boolean): void;
  stop(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += (chunk as Buffer).toString("utf8");
  if (text === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length);
  return token === "" ? undefined : token;
}

function send(res: ServerResponse, status: number, json?: unknown): void {
  res.statusCode = status;
  if (json !== undefined) res.setHeader("content-type", "application/json");
  res.end(json === undefined ? undefined : JSON.stringify(json));
}

function wallClockSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Starts the mock publisher on `127.0.0.1` with an OS-assigned port. */
export async function startMockPublisher(
  options: MockPublisherOptions = {},
): Promise<MockPublisher> {
  const now = options.now ?? wallClockSeconds;
  const { issuer, publicKey } = await createReferenceLicenseIssuer();
  const licensePublicKeyPaserk = await exportLicensePublicKey(publicKey);

  let runtimePublicKey = options.runtimePublicKey;
  let failCleanupOnce = false;
  let declineReissue = false;
  let issueHits = 0;
  let reissueHits = 0;
  let invalidateHits = 0;
  let cleanupHits = 0;
  const seenJtis: string[] = [];
  const issuedTokens: string[] = [];
  const invalidatedLeaseIds: string[] = [];
  // Leases this publisher issued for: a cleanup bearer is only honored for one of them (scope-bound, spec section 10).
  const knownLeaseIds = new Set<string>();

  async function handleIssue(
    body: Record<string, unknown>,
    reissue: boolean,
    res: ServerResponse,
  ): Promise<void> {
    if (reissue) reissueHits += 1;
    else issueHits += 1;

    const claims = body.claims as LicenseClaims | undefined;
    if (claims === undefined || typeof claims.lease_id !== "string") {
      send(res, 400);
      return;
    }
    if (reissue && declineReissue) {
      send(res, 200, { license: null });
      return;
    }
    const specVersion = String(body.spec_version);
    const issuedAt = body.now as number;
    const held = reissue
      ? await issuer.reissue(claims, specVersion, issuedAt, body.lease_expires_at as number)
      : await issuer.issue(claims, specVersion, issuedAt, body.exp as number);
    if (held === null) {
      send(res, 200, { license: null });
      return;
    }
    knownLeaseIds.add(claims.lease_id);
    const token = readLicenseToken(held);
    issuedTokens.push(token);
    send(res, 200, { license: token });
  }

  async function handleCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cleanupHits += 1;
    const token = bearerOf(req);
    if (token === undefined || runtimePublicKey === undefined) {
      send(res, 401);
      return;
    }
    const claims = await verifyCleanupToken(token, runtimePublicKey, now());
    if (claims === null) {
      send(res, 401);
      return;
    }
    // The scope is `cleanup:<lease_id>`; only a lease this publisher issued for is honored.
    const leaseId = claims.scope.slice("cleanup:".length);
    if (!knownLeaseIds.has(leaseId)) {
      send(res, 403);
      return;
    }
    if (seenJtis.includes(claims.jti)) {
      send(res, 409);
      return;
    }
    if (failCleanupOnce) {
      failCleanupOnce = false;
      send(res, 500);
      return;
    }
    seenJtis.push(claims.jti);
    send(res, 200);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        send(res, 405);
        return;
      }
      const url = req.url ?? "";
      if (url === "/alp/cleanup") {
        await handleCleanup(req, res);
        return;
      }
      const body = await readJson(req);
      if (url === "/license/issue") {
        await handleIssue(body, false, res);
      } else if (url === "/license/reissue") {
        await handleIssue(body, true, res);
      } else if (url === "/license/invalidate") {
        invalidateHits += 1;
        const leaseId = body.lease_id;
        if (typeof leaseId !== "string") {
          send(res, 400);
          return;
        }
        await issuer.invalidate(leaseId);
        invalidatedLeaseIds.push(leaseId);
        send(res, 204);
      } else {
        send(res, 404);
      }
    })().catch(() => {
      // Never echo an internal error to the caller.
      send(res, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl,
    issueUrl: `${baseUrl}/license/issue`,
    reissueUrl: `${baseUrl}/license/reissue`,
    invalidateUrl: `${baseUrl}/license/invalidate`,
    cleanupUrl: `${baseUrl}/alp/cleanup`,
    licensePublicKeyPaserk,
    get issueHits() {
      return issueHits;
    },
    get reissueHits() {
      return reissueHits;
    },
    get invalidateHits() {
      return invalidateHits;
    },
    get cleanupHits() {
      return cleanupHits;
    },
    seenJtis,
    invalidatedLeaseIds,
    issuedTokens,
    setRuntimePublicKey(key) {
      runtimePublicKey = key;
    },
    failNextCleanup() {
      failCleanupOnce = true;
    },
    declineReissue(decline) {
      declineReissue = decline;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
