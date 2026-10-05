import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { credentialSecretKey } from "@stint/core";
import {
  createInMemoryKeyProvider,
  createInMemoryLeaseArtifactStore,
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createInMemorySecretStore,
  makeTestLease,
} from "@stint/core/testing";
import { settleExpired } from "@stint/runtime";
import type { RuntimePorts } from "@stint/runtime";
import { generateKeyPair, exportJWK } from "jose";

import type { CliDeps } from "../src/deps.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { createHarness } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("buildRuntimePorts", () => {
  it("with none of the new seams set, returns ports backed by the file stores under the root", async () => {
    harness = await createHarness();
    const { deps, root } = harness;
    const ports = buildRuntimePorts(deps, root);

    await ports.secrets.put(credentialSecretKey("lease-1", "sheets"), "s3cret");
    expect(await ports.secrets.get(credentialSecretKey("lease-1", "sheets"))).toBe("s3cret");
    expect(readdirSync(path.join(root, "secrets", "lease"))).toEqual(["lease-1"]);

    await ports.artifacts.put("lease-1", "grants", { version: 1, grants: [] });
    expect(readdirSync(path.join(root, "leases", "lease-1"))).toContain("grants.json");

    const key = await ports.keys.loadOrCreate();
    expect(readdirSync(path.join(root, "keys")).sort()).toEqual([
      "runtime-ed25519.json",
      "runtime-ed25519.pub.json",
    ]);
    expect((await ports.keys.loadVerificationKeys()).map((k) => k.kid)).toEqual([key.kid]);
  });

  it("uses deps.secrets, deps.artifacts and deps.keyProvider when they are set", async () => {
    harness = await createHarness();
    const secrets = createInMemorySecretStore();
    const artifacts = createInMemoryLeaseArtifactStore();
    const keyProvider = createInMemoryKeyProvider();
    const seen: string[] = [];
    const deps: CliDeps = {
      ...harness.deps,
      secrets: (root) => {
        seen.push(`secrets:${root}`);
        return secrets;
      },
      artifacts: (root) => {
        seen.push(`artifacts:${root}`);
        return artifacts;
      },
      keyProvider: (root) => {
        seen.push(`keys:${root}`);
        return keyProvider;
      },
    };
    const ports = buildRuntimePorts(deps, harness.root);
    expect(ports.secrets).toBe(secrets);
    expect(ports.artifacts).toBe(artifacts);
    expect(ports.keys).toBe(keyProvider);
    expect(seen).toEqual([
      `secrets:${harness.root}`,
      `artifacts:${harness.root}`,
      `keys:${harness.root}`,
    ]);
    // Nothing was written to disk by the file defaults.
    expect(readdirSync(harness.root)).toEqual([]);
  });

  it("ports.trust() resolves what deps.loadTrustStore(root, { trust }) resolves", async () => {
    harness = await createHarness();
    const calls: unknown[] = [];
    const jwk = await exportJWK((await generateKeyPair("EdDSA", { crv: "Ed25519" })).publicKey);
    const trustFile = path.join(harness.root, "explicit-trust.json");
    writeFileSync(trustFile, JSON.stringify({ keys: [] }));
    const sentinel = { sentinel: jwk.x } as never;
    const deps: CliDeps = {
      ...harness.deps,
      loadTrustStore: (root, opts) => {
        calls.push([root, opts]);
        return Promise.resolve(sentinel);
      },
    };
    const ports = buildRuntimePorts(deps, harness.root, { trust: trustFile });
    expect(await ports.trust()).toBe(sentinel);
    expect(calls).toEqual([[harness.root, { trust: trustFile }]]);

    const noOpts = buildRuntimePorts(deps, harness.root);
    await noOpts.trust();
    expect(calls[1]).toEqual([harness.root, { trust: undefined }]);
  });

  it("ports.receipts(leaseId) is deps.receiptStoreFactory(root, leaseId) and ports.leases is deps.storeFactory(root)", async () => {
    harness = await createHarness();
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    const receiptCalls: unknown[] = [];
    const storeCalls: unknown[] = [];
    const deps: CliDeps = {
      ...harness.deps,
      storeFactory: (root) => {
        storeCalls.push(root);
        return leaseStore;
      },
      receiptStoreFactory: (root, leaseId) => {
        receiptCalls.push([root, leaseId]);
        return receiptStore;
      },
    };
    const ports = buildRuntimePorts(deps, harness.root);
    expect(ports.leases).toBe(leaseStore);
    expect(storeCalls).toEqual([harness.root]);
    expect(ports.receipts("lease-9")).toBe(receiptStore);
    expect(receiptCalls).toEqual([[harness.root, "lease-9"]]);
  });

  it("keeps deps.keys in control of the key when no keyProvider seam is set", async () => {
    harness = await createHarness();
    const inner = createInMemoryKeyProvider();
    const key = await inner.loadOrCreate();
    const deps: CliDeps = {
      ...harness.deps,
      keys: {
        loadOrCreate: () => inner.loadOrCreate(),
        loadPublic: () => Promise.resolve(key.publicKey),
      },
    };
    const ports = buildRuntimePorts(deps, harness.root);
    expect((await ports.keys.loadOrCreate()).kid).toBe(key.kid);
    expect((await ports.keys.loadVerificationKeys()).map((k) => k.kid)).toEqual([key.kid]);
  });

  it("loadVerificationKeys resolves [] before any key exists, without creating one", async () => {
    harness = await createHarness();
    const ports = buildRuntimePorts(harness.deps, harness.root);
    expect(await ports.keys.loadVerificationKeys()).toEqual([]);
    expect(readdirSync(harness.root)).toEqual([]);
  });

  it("settleExpired still accepts a value that has only leases, receipts, clock and telemetry", async () => {
    const leases = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    const minimal: Pick<RuntimePorts, "leases" | "receipts" | "clock" | "telemetry"> = {
      leases,
      receipts: () => receiptStore,
      clock: () => 6000,
    };
    await leases.save(makeTestLease("lease-min", { expiresAt: 5000 }));
    const result = await settleExpired(minimal, "lease-min");
    expect(result.settled).toBe(true);
    expect(result.lease.state).toBe("expired");
  });
});
