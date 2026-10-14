/**
 * The example's signed hybrid manifest. It is the conformance vector
 * `spec/vectors/valid/payment-reconciler.json` (hybrid auth, Paystack read,
 * orders sheet read+write, `approvals.require_for: ["irreversible"]`, a
 * `resource_query` verifier on `sheets.orders`) with only two runtime-shaped
 * overrides: `cleanup.hook.url` points at the loopback mock publisher and
 * `approvals.timeout_seconds` is short enough for a test to assert a timeout.
 * Everything else (auth mode, scopes, verifier) stays exactly as the vector
 * defines it.
 *
 * It is signed with a FRESH publisher key through `@stint/spec/testing`, which
 * imports only `jose` (no test runner). The caller writes the returned trust
 * entry to the trust file `stint create` consumes.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Manifest, SignedEnvelope, TrustStore } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";
import type { CryptoKey } from "jose";

/** The key id the example's manifest is signed under. */
export const PUBLISHER_KID = "example-key";

/** `src/` and the bundled `dist/` sit at the same depth, so one relative path serves both. */
const VECTOR_PATH = fileURLToPath(
  new URL("../../../spec/vectors/valid/payment-reconciler.json", import.meta.url),
);

/** Options for {@link buildSignedManifest}. */
export interface BuildSignedManifestOptions {
  /** The loopback mock publisher's `/alp/cleanup` URL (https or loopback http only). */
  readonly cleanupUrl: string;
  /** `approvals.timeout_seconds`: 1-2s where a test asserts a timeout, larger otherwise. */
  readonly approvalTimeoutSeconds: number;
}

/** A signed manifest plus everything a harness needs to register and re-use its publisher. */
export interface BuiltManifest {
  /** The manifest the envelope carries (unsigned view, for assertions). */
  readonly manifest: Manifest;
  readonly envelope: SignedEnvelope;
  /** The serialized envelope `stint create <file>` reads. */
  readonly envelopeBytes: Uint8Array;
  /** `{ [publisher.id]: { [kid]: publicJwk } }` -- the content of the trust file. */
  readonly trustEntry: TrustStore;
  /** `trustEntry` serialized, ready to write to `<store>/trust.json`. */
  readonly trustJson: string;
  /** The publisher's private signing key (re-signing / rotation scenarios). */
  readonly publisherPrivateKey: CryptoKey;
}

async function loadVectorManifest(): Promise<Manifest> {
  const vector = JSON.parse(await readFile(VECTOR_PATH, "utf8")) as { manifest: Manifest };
  return vector.manifest;
}

/** Builds and signs the hybrid manifest with a freshly generated publisher key. */
export async function buildSignedManifest(options: BuildSignedManifestOptions): Promise<BuiltManifest> {
  const base = await loadVectorManifest();
  const manifest: Manifest = {
    ...base,
    approvals: { ...base.approvals, timeout_seconds: options.approvalTimeoutSeconds },
    cleanup: {
      hook: { url: options.cleanupUrl },
      publisher_retains: base.cleanup?.publisher_retains ?? "aggregates",
    },
  };

  return await signBuilt(manifest);
}

/** Signs `manifest` with a fresh publisher key and packages everything a harness needs. */
async function signBuilt(manifest: Manifest): Promise<BuiltManifest> {
  const { envelope, trustStore, privateKey } = await signManifestForTest(manifest, {
    kid: PUBLISHER_KID,
  });

  return {
    manifest,
    envelope,
    envelopeBytes: new TextEncoder().encode(JSON.stringify(envelope)),
    trustEntry: trustStore,
    trustJson: JSON.stringify(trustStore),
    publisherPrivateKey: privateKey,
  };
}

/** Options for {@link buildSignedPaymentManifest}. */
export interface BuildSignedPaymentManifestOptions {
  /** `approvals.timeout_seconds`: also bounds the user-confirmation prompt, so tests keep it modest. */
  readonly approvalTimeoutSeconds: number;
}

/**
 * The payment-confirmation manifest (Phase 10, PSTK-06): the vector's identity,
 * limits and approvals, narrowed to one delegated, read-only Paystack grant. The
 * job fixes its three inputs at create (`reference`, `expected_amount_kobo`,
 * `currency`) and is verified by the connector-computed verdict, never by the
 * agent: `exists(rows where verdict = 'confirmed') >= 1` over
 * `paystack.transactions`. There is no hosted license and no cleanup hook (the
 * lease is purely delegated), so it needs no publisher. Signed through the same
 * path as {@link buildSignedManifest}.
 */
export async function buildSignedPaymentManifest(
  options: BuildSignedPaymentManifestOptions,
): Promise<BuiltManifest> {
  const base = await loadVectorManifest();
  const manifest: Manifest = {
    ...base,
    job: {
      description: "Confirm that the expected Paystack payment arrived.",
      parameters: [
        { name: "reference", type: "string" },
        { name: "expected_amount_kobo", type: "integer" },
        { name: "currency", type: "currency" },
      ],
      verifier: {
        type: "resource_query",
        resource: "paystack.transactions",
        predicate: "exists(rows where verdict = 'confirmed') >= 1",
      },
    },
    scopes: [{ resource: "paystack.transactions", access: ["read"] }],
    approvals: { ...base.approvals, timeout_seconds: options.approvalTimeoutSeconds },
    auth: {
      mode: "delegated",
      delegated: [{ provider: "paystack", resources: ["paystack.transactions"] }],
    },
    cleanup: null,
  };
  return await signBuilt(manifest);
}

/**
 * Writes `manifest.json` and `trust.json` under `dir` (the store root for the
 * trust file) and returns their paths.
 */
export async function writeManifestFiles(
  dir: string,
  built: BuiltManifest,
): Promise<{ readonly manifestPath: string; readonly trustPath: string }> {
  const manifestPath = path.join(dir, "manifest.json");
  const trustPath = path.join(dir, "trust.json");
  await writeFile(manifestPath, built.envelopeBytes);
  await writeFile(trustPath, built.trustJson);
  return { manifestPath, trustPath };
}
