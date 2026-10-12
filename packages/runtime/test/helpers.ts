import {
  createInMemoryKeyProvider,
  createInMemoryLeaseArtifactStore,
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createInMemorySecretStore,
} from "@stint/core/testing";
import type { ReceiptStore } from "@stint/core";
import type { OAuthSeededCredential } from "@stint/proxy";
import type { Manifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";

import type { RuntimePorts } from "../src/index.js";

export const NOW = 2000;

export function manifestFor(auth: Manifest["auth"], scopeResources: readonly string[] = ["sheets.orders"]): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: { id: "reconciler", name: "Order Reconciler", description: "Reconciles orders." },
    publisher: { id: "pub.example", name: "Pub Example" },
    version: "1.0.0",
    job: { description: "Reconcile the order sheet.", verifier: { type: "none" } },
    scopes: scopeResources.map((resource) => ({ resource, access: ["read", "write"] })) as Manifest["scopes"],
    lease: { max_duration_seconds: 3600 },
    limits: { max_actions: 25, actions_per_hour: 10 },
    approvals: { require_for: ["send"], timeout_seconds: 60 },
    auth,
    cleanup: null,
  };
}

export function delegatedManifest(resources: readonly string[]): Manifest {
  return manifestFor(
    {
      mode: "delegated",
      delegated: [{ provider: "google", resources: [...resources] }],
    } as Manifest["auth"],
    resources,
  );
}

export function hostedManifest(): Manifest {
  return manifestFor({ mode: "hosted", hosted: { license_issuer: "pub.example" } });
}

export interface Rig {
  readonly ports: RuntimePorts;
  readonly receiptStores: Map<string, ReceiptStore>;
}

/** In-memory ports, a trust store for `manifest`'s publisher and the signed envelope stored for `leaseId`. */
export async function buildRig(leaseId: string, manifest: Manifest | undefined): Promise<Rig> {
  const receiptStores = new Map<string, ReceiptStore>();
  const artifacts = createInMemoryLeaseArtifactStore();
  let trust: Awaited<ReturnType<RuntimePorts["trust"]>> = {};
  if (manifest !== undefined) {
    const signed = await signManifestForTest(manifest, { kid: "k1" });
    trust = signed.trustStore;
    await artifacts.put(leaseId, "envelope", signed.envelope);
  }
  const ports: RuntimePorts = {
    leases: createInMemoryLeaseStore(),
    receipts: (id) => {
      let store = receiptStores.get(id);
      if (store === undefined) {
        store = createInMemoryReceiptStore();
        receiptStores.set(id, store);
      }
      return store;
    },
    clock: () => NOW,
    secrets: createInMemorySecretStore(),
    artifacts,
    keys: createInMemoryKeyProvider(),
    trust: () => Promise.resolve(trust),
  };
  return { ports, receiptStores };
}

export function oauthCredential(
  tokenEndpoint: string,
  revocationEndpoint: string | undefined,
  overrides: Partial<OAuthSeededCredential> = {},
): OAuthSeededCredential {
  return {
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiry: NOW + 100_000,
    tokenEndpoint,
    resourceIndicator: "https://resource.example/",
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    ...overrides,
  };
}
