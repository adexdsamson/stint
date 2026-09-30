/**
 * In-process CLI test harness: a temp store, captured IO, a fake clock, and a
 * `HostAdapter` factory whose answers the test scripts. No child processes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ApprovalDecision,
  ConsentDecision,
  HostAdapter,
  OutcomeConfirmDecision,
} from "@stint/core";
import type { Manifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";

import type { CliDeps } from "../../src/deps.js";
import { loadCheckpointPublicKey, loadOrCreateRuntimeKey } from "../../src/keys/runtime-key.js";
import { loadCredentials, seedVaultFromCredentials } from "../../src/run/credentials.js";
import { createJsonLeaseStore } from "../../src/store/json-lease-store.js";
import { createJsonReceiptStore } from "../../src/store/json-receipt-store.js";
import { loadTrustStore } from "../../src/trust/trust-store.js";

export const NOW = 1_800_000_000;

export interface Harness {
  readonly root: string;
  readonly deps: CliDeps;
  readonly stdout: string[];
  readonly stderr: string[];
  /** Everything written, joined, for "must not contain" assertions. */
  readonly allOutput: () => string;
  readonly cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  /** What the scripted adapter answers to a consent request. Default: grant. */
  readonly consent?: (signal: AbortSignal) => Promise<ConsentDecision>;
  readonly consentTimeoutSeconds?: number;
}

function scriptedAdapter(options: HarnessOptions): HostAdapter {
  return {
    requestConsent: (_request, signal) =>
      (options.consent ?? (() => Promise.resolve({ decision: "grant" } as const)))(signal),
    requestApproval: () =>
      Promise.resolve({ decision: "deny", reason: "user_denied" } satisfies ApprovalDecision),
    requestOutcomeConfirmation: () =>
      Promise.resolve({
        decision: "reject",
        reason: "user_rejected",
      } satisfies OutcomeConfirmDecision),
    notify: () => Promise.resolve(),
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stint-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDeps = {
    io: {
      out: (t) => stdout.push(t),
      err: (t) => stderr.push(t),
    },
    clock: () => NOW,
    storeFactory: (r) => createJsonLeaseStore({ root: r }),
    receiptStoreFactory: (r, leaseId) => createJsonReceiptStore({ root: r, leaseId }),
    adapterFactory: () => scriptedAdapter(options),
    ...(options.consentTimeoutSeconds === undefined
      ? {}
      : { consentTimeoutSeconds: options.consentTimeoutSeconds }),
    keys: { loadOrCreate: loadOrCreateRuntimeKey, loadPublic: loadCheckpointPublicKey },
    loadTrustStore,
    credentials: { load: loadCredentials, seedVault: seedVaultFromCredentials },
  };
  return {
    root,
    deps,
    stdout,
    stderr,
    allOutput: () => [...stdout, ...stderr].join(""),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A minimal delegated-only manifest (hybrid/hosted are deferred to Phase 7, A8). */
export function delegatedManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: { id: "reconciler", name: "Order Reconciler", description: "Reconciles orders." },
    publisher: { id: "pub.example", name: "Pub Example" },
    version: "1.0.0",
    job: { description: "Reconcile the order sheet.", verifier: { type: "none" } },
    scopes: [{ resource: "sheets.orders", access: ["read", "write"] }],
    lease: { max_duration_seconds: 3600 },
    limits: { max_actions: 25, actions_per_hour: 10 },
    approvals: { require_for: ["send"], timeout_seconds: 60 },
    auth: {
      mode: "delegated",
      delegated: [{ provider: "google", resources: ["sheets.orders"] }],
    },
    cleanup: null,
    ...overrides,
  };
}

export interface SignedFixture {
  readonly manifestPath: string;
  /** Write this into `<root>/trust.json` to trust the fixture's publisher. */
  readonly trustJson: string;
}

/** Signs `manifest`, writes the envelope under `dir`, and returns the path and matching trust file text. */
export async function writeSignedManifest(
  dir: string,
  manifest: Manifest,
  fileName = "manifest.json",
): Promise<SignedFixture> {
  const { envelope, publicJwk } = await signManifestForTest(manifest, { kid: "k1" });
  const manifestPath = path.join(dir, fileName);
  await writeFile(manifestPath, JSON.stringify(envelope));
  return {
    manifestPath,
    trustJson: JSON.stringify({ [manifest.publisher.id]: { k1: publicJwk } }),
  };
}
