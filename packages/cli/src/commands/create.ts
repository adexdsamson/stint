/**
 * `stint create <manifest-path>`: verify, consent, activate.
 *
 *   read -> parseEnvelope -> verifyEnvelope(trustStore) -> [hosted gate] ->
 *   renderConsent (via the adapter) -> awaitConsentDecision ->
 *   reduce(consentGranted) -> activateLease -> save
 *
 * Deny by default: an unparseable, tampered, or untrusted manifest fails
 * BEFORE any consent is shown, and every non-grant (decline, timeout, adapter
 * error, no TTY) leaves the lease `declined`. Every failure message is fixed
 * text; verification/jose error text and stacks are never printed.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { activateLease, awaitConsentDecision, clockEvents, reduce, userEvents } from "@stint/core";
import type { Lease } from "@stint/core";
import { MAX_ENVELOPE_BYTES, parseEnvelope, resolveAuthMode, verifyEnvelope } from "@stint/spec";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { resolveStoreRoot } from "../paths.js";

/** ASSUMED (A3): the manifest carries no consent timeout field; matches the terminal adapter's default. */
const DEFAULT_CONSENT_TIMEOUT_SECONDS = 120;

export interface CreateOpts extends GlobalOpts {
  readonly trust?: string | undefined;
}

/** Reads the manifest file with a size cap applied BEFORE the bytes are loaded. */
async function readManifestBytes(file: string): Promise<Uint8Array> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new CliError(EXIT_CODES.usage, "The manifest file could not be read.");
  }
  if (size > MAX_ENVELOPE_BYTES) {
    throw new CliError(EXIT_CODES.manifestInvalid, "The manifest is too large.");
  }
  try {
    return await readFile(file);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The manifest file could not be read.");
  }
}

function newLease(id: string, boundHash: string, maxDurationSeconds: number): Lease {
  return {
    id,
    state: "proposed",
    version: 0,
    boundHash,
    grantedAt: 0,
    expiresAt: 0,
    maxDurationSeconds,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
  };
}

export async function createCommand(
  deps: CliDeps,
  manifestPath: string,
  opts: CreateOpts,
): Promise<number> {
  const root = resolveStoreRoot(opts);
  const json = opts.json === true;

  // 1. Parse. `parseEnvelope` can throw on invalid UTF-8; that is a rejection, not a crash.
  const bytes = await readManifestBytes(manifestPath);
  let parsed: ReturnType<typeof parseEnvelope>;
  try {
    parsed = parseEnvelope(bytes);
  } catch {
    throw new CliError(EXIT_CODES.manifestInvalid, "The manifest could not be parsed.");
  }
  if (!parsed.ok) {
    throw new CliError(EXIT_CODES.manifestInvalid, "The manifest could not be parsed.");
  }

  // 2. Verify against the trust store BEFORE any consent (T-06-12). The reason
  // is a member of the fixed SPEC_ERROR_CODES vocabulary, never upstream text.
  const trustStore = await deps.loadTrustStore(root, { trust: opts.trust });
  const verified = await verifyEnvelope(parsed.value, trustStore);
  if (!verified.ok) {
    const reason = verified.errors[0]?.code ?? "invalid_signature";
    throw new CliError(EXIT_CODES.manifestInvalid, `The manifest failed verification (${reason}).`);
  }
  const manifest = verified.value.manifest;

  // 3. Hosted/hybrid activation needs a license issuer; live issuance is Phase 7 (A8).
  // Surfaced as an explicit refusal, not silently dropped, and before any consent.
  if (resolveAuthMode(manifest) !== "delegated") {
    throw new CliError(
      EXIT_CODES.manifestInvalid,
      "Hosted license issuance is not available in this phase; only delegated-auth manifests can be activated.",
    );
  }

  // 4. Ensure the runtime signing key exists (created on first create, A4).
  await deps.keys.loadOrCreate(root);

  // 5. Consent, with the timeout armed here and the outcome decided by core.
  const now = deps.clock();
  const leaseId = randomUUID();
  const proposed = newLease(
    leaseId,
    verified.value.contentHash,
    manifest.lease.max_duration_seconds,
  );
  const adapter = deps.adapterFactory(deps.io, {
    json,
    approvalTimeoutSeconds: manifest.approvals.timeout_seconds,
  });

  const controller = new AbortController();
  const timeoutSeconds = deps.consentTimeoutSeconds ?? DEFAULT_CONSENT_TIMEOUT_SECONDS;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutSeconds * 1000);
  let decision: Awaited<ReturnType<typeof awaitConsentDecision>>;
  try {
    decision = await awaitConsentDecision(
      adapter,
      { consentId: randomUUID(), manifest: verified.value },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
    // Lets an adapter that is still prompting stop its own UI.
    controller.abort();
  }

  const store = deps.storeFactory(root);

  if (decision.decision !== "grant") {
    const event =
      decision.reason === "timeout" ? clockEvents.consentTimedOut() : userEvents.consentDeclined();
    const declined = reduce(proposed, event, now);
    if (!declined.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
    await store.save(declined.value.lease);
    throw new CliError(
      EXIT_CODES.consentDeclined,
      "Consent was not granted; no lease was activated.",
    );
  }

  // 6. Grant -> activate. The bound-hash guard lives inside activateLease (D-21).
  const granted = reduce(proposed, userEvents.consentGranted(), now);
  if (!granted.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
  const activated = activateLease(granted.value.lease, verified.value, now);
  if (!activated.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
  const lease = activated.value.lease;
  await store.save(lease);
  if (lease.state !== "active") {
    throw new CliError(EXIT_CODES.wrongState, "The lease could not be activated.");
  }

  if (json) {
    deps.io.out(
      `${JSON.stringify({ leaseId: lease.id, state: lease.state, expiresAt: lease.expiresAt })}\n`,
    );
  } else {
    deps.io.out(`${lease.id}\n`);
    deps.io.err(
      `stint: lease active until ${new Date(lease.expiresAt * 1000).toISOString()}. Inspect it with: stint inspect ${lease.id}\n`,
    );
  }
  return EXIT_CODES.ok;
}
