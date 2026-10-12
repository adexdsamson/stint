/**
 * Phase 9 D-09, second half: every in-process teardown driver of a live run is
 * fenced. A call-triggered teardown (`dispatch.ts`) and a verifier-triggered
 * teardown (`completeViaVerifier`) pass `ProxyDeps.teardownFence` /
 * `VerifierCompletionDeps.teardownFence` to `runTeardown`, and treat a
 * `TeardownFencedError` as "another driver owns this pass": the call's own
 * result is unchanged and nothing throws.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createBindingSet, verifyChain } from "@stint/core";
import type { ConnectorBinding, Lease, TeardownStepName } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER, handleCall } from "../src/dispatch.js";
import type { ExecuteStage } from "../src/dispatch.js";
import { completeViaVerifier, createDefaultTeardownSteps, TEARDOWN_STEP_ORDER } from "../src/index.js";
import type { ProxyDeps, TeardownFenceConfig, TeardownStep } from "../src/index.js";
import { CredentialRefreshError } from "../src/vault/credential-vault.js";

const NOW = 1_700_000_000;
const TTL = 120;
const FENCE: TeardownFenceConfig = { clock: () => NOW, ttlSeconds: TTL };

const BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

let signingKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }));
});

type Runs = Record<TeardownStepName, number>;

/** The default steps, wrapped so every run is counted. */
function countingSteps(receiptStore: ReturnType<typeof createInMemoryReceiptStore>): {
  steps: readonly TeardownStep[];
  runs: Runs;
} {
  const runs = Object.fromEntries(TEARDOWN_STEP_ORDER.map((n) => [n, 0])) as Runs;
  const steps = createDefaultTeardownSteps(receiptStore, signingKey).map(
    (inner): TeardownStep => ({
      name: inner.name,
      run(lease, now) {
        runs[inner.name] += 1;
        return inner.run(lease, now);
      },
    }),
  );
  return { steps, runs };
}

function totalRuns(runs: Runs): number {
  return TEARDOWN_STEP_ORDER.reduce((sum, name) => sum + runs[name], 0);
}

/** A lease another driver holds the teardown fence on (live for another minute). */
const HELD_ELSEWHERE = { epoch: 1, expiresAt: NOW + 60 };

describe("dispatch driver under a teardown fence (D-09)", () => {
  async function build(leaseId: string, fence: { epoch: number; expiresAt: number } | undefined) {
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    await leaseStore.save(
      makeTestLease(leaseId, {
        grantedAt: NOW - 100,
        expiresAt: NOW + 3600,
        ...(fence === undefined ? {} : { fence }),
      }),
    );
    const { steps, runs } = countingSteps(receiptStore);
    const execute: ExecuteStage = {
      execute: () => Promise.reject(new CredentialRefreshError(`${leaseId}:inbox`, "provider_revoked")),
    };
    const deps: ProxyDeps = {
      leaseId,
      leaseStore,
      receiptStore,
      catalog: createToolCatalog([
        {
          name: BINDING.tool,
          description: "Reads a message",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ]),
      bindings: createBindingSet([BINDING]),
      grantedScopes: ["read"],
      grantedResources: [BINDING.resource],
      limits: { max_actions: 100 },
      approvals: { require_for: [], timeout_seconds: 30 },
      clock: () => NOW,
      execute,
      approve: DEFAULT_APPROVAL_STAGE,
      enforceCaps: DEFAULT_CAP_ENFORCER,
      teardownSteps: steps,
      teardownFence: FENCE,
    };
    return { deps, leaseStore, receiptStore, runs };
  }

  it("with no fence held, a revoked call's teardown lands cleaned_up with the fence released at epoch 1", async () => {
    const { deps, leaseStore, receiptStore } = await build("lease-dispatch-free", undefined);

    const result = await handleCall(deps, { name: BINDING.tool, arguments: {} }, NOW);

    expect(result.isError).toBe(true);
    const lease = await leaseStore.load("lease-dispatch-free");
    expect(lease?.state).toBe("cleaned_up");
    expect(lease?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect((await verifyChain(await receiptStore.load("verified"))).ok).toBe(true);
  });

  it("a revoked call under a live fence held elsewhere returns the same result, throws nothing, runs no step and leaves the other fence untouched", async () => {
    const free = await build("lease-dispatch-free-ref", undefined);
    const referenceResult = await handleCall(free.deps, { name: BINDING.tool, arguments: {} }, NOW);

    const held = await build("lease-dispatch-held", HELD_ELSEWHERE);
    const heldResult = await handleCall(held.deps, { name: BINDING.tool, arguments: {} }, NOW);

    expect(heldResult).toEqual(referenceResult);
    expect(totalRuns(held.runs)).toBe(0);

    const lease: Lease | undefined = await held.leaseStore.load("lease-dispatch-held");
    expect(lease?.state).toBe("tearing_down");
    expect(lease?.fence).toEqual(HELD_ELSEWHERE);
    expect(lease?.teardownProgress ?? {}).toEqual({});

    const chain = await held.receiptStore.load("verified");
    expect(chain.filter((e) => e.type === "teardown_step")).toHaveLength(0);
    expect(chain.filter((e) => e.type === "teardown_takeover")).toHaveLength(0);
    expect((await verifyChain(chain)).ok).toBe(true);
  });
});

describe("verifier driver under a teardown fence (D-09)", () => {
  async function build(leaseId: string, fence: { epoch: number; expiresAt: number } | undefined) {
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    await leaseStore.save(makeTestLease(leaseId, fence === undefined ? {} : { fence }));
    const { steps, runs } = countingSteps(receiptStore);
    return { leaseStore, receiptStore, runs, steps, leaseId };
  }

  it("with no fence held, completion lands cleaned_up with the fence released", async () => {
    const rig = await build("lease-verifier-free", undefined);

    await completeViaVerifier(
      {
        leaseStore: rig.leaseStore,
        receiptStore: rig.receiptStore,
        leaseId: rig.leaseId,
        teardownSteps: rig.steps,
        teardownFence: FENCE,
      },
      NOW,
    );

    const lease = await rig.leaseStore.load(rig.leaseId);
    expect(lease?.state).toBe("cleaned_up");
    expect(lease?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect((await verifyChain(await rig.receiptStore.load("verified"))).ok).toBe(true);
  });

  it("with a live fence held elsewhere, completion resolves without throwing and runs no step", async () => {
    const rig = await build("lease-verifier-held", HELD_ELSEWHERE);

    await expect(
      completeViaVerifier(
        {
          leaseStore: rig.leaseStore,
          receiptStore: rig.receiptStore,
          leaseId: rig.leaseId,
          teardownSteps: rig.steps,
          teardownFence: FENCE,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();

    expect(totalRuns(rig.runs)).toBe(0);
    const lease = await rig.leaseStore.load(rig.leaseId);
    expect(lease?.state).toBe("tearing_down");
    expect(lease?.fence).toEqual(HELD_ELSEWHERE);
    expect((await verifyChain(await rig.receiptStore.load("verified"))).ok).toBe(true);
  });

  it("without teardownFence the completion is unfenced exactly as before (no fence field written)", async () => {
    const rig = await build("lease-verifier-unfenced", undefined);

    await completeViaVerifier(
      { leaseStore: rig.leaseStore, receiptStore: rig.receiptStore, leaseId: rig.leaseId, teardownSteps: rig.steps },
      NOW,
    );

    const lease = await rig.leaseStore.load(rig.leaseId);
    expect(lease?.state).toBe("cleaned_up");
    expect(lease?.fence).toBeUndefined();
  });
});
