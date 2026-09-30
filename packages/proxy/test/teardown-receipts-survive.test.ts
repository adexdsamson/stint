/**
 * Phase 5 Plan 8, Task 1: RCPT-07 (both receipt chains -- including the
 * final signed receipt -- survive cleanup and remain verifiable, the
 * attested chain independently), D-17 (step 4's real delete/retain split:
 * credential + license gone, receipts + lease + progress retained), and
 * D-31 (a checkpoint brackets the terminal transition, a second brackets
 * the completed teardown; both are independently non-repudiable).
 *
 * Uses the SAME real collaborators 05-04/05-05/05-06's own tests use (a
 * real loopback OAuth mock AS for `revoke_oauth`, a real `MockLicenseIssuer`
 * + in-memory `LicenseCustody` for `invalidate_license`/step 4's sweep, and
 * a real loopback HTTP server for `cleanup_hook`) so this test exercises the
 * ACTUAL `createDefaultTeardownSteps` wiring, not a stand-in.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendEntry, verifyChain, verifyCheckpoint } from "@stint/core";
import type { Checkpoint, HeldLicense, Lease, ReceiptStore } from "@stint/core";
import {
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createMockLicenseIssuer,
  makeTestLease,
} from "@stint/core/testing";
import type { MockLicenseIssuer } from "@stint/core/testing";

import { createDefaultTeardownSteps, retryTeardown, runTeardown } from "../src/index.js";
import type { LicenseCustody, TeardownDeps } from "../src/index.js";
import { createCredentialVault } from "../src/vault/credential-vault.js";
import type { CredentialVault } from "../src/vault/credential-vault.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;
const RESOURCE = "inbox";
const ACCESS_TOKEN = "access-token-rcpt07-must-never-leak";
const REFRESH_TOKEN = "refresh-token-rcpt07-must-never-leak";

// --- Shared test doubles / helpers ------------------------------------------

/** Mirrors `entitlement-revocation.test.ts`'s private `LicenseCustody` double -- no production per-lease license store exists yet. */
function createInMemoryLicenseCustody(): LicenseCustody & { seed(leaseId: string, license: HeldLicense): void } {
  const held = new Map<string, HeldLicense>();
  return {
    seed(leaseId: string, license: HeldLicense): void {
      held.set(leaseId, license);
    },
    hasLicense(leaseId: string): boolean {
      return held.has(leaseId);
    },
    discard(leaseId: string): void {
      held.delete(leaseId);
    },
  };
}

async function mintTestHeldLicense(issuer: MockLicenseIssuer, leaseId: string): Promise<HeldLicense> {
  return issuer.issue(
    { lease_id: leaseId, job: { description: "test job" }, limits: { max_actions: 10, actions_per_hour: null } },
    "alp/0.1",
    NOW,
    NOW + 3600,
  );
}

interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

/** A real loopback HTTP server -- mirrors `cleanup-token.test.ts`'s helper, so `postCleanupToken` makes a genuine network call, never a mocked `fetch`. */
function startTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections();
            server.close(() => {
              resolveClose();
            });
          }),
      });
    });
  });
}

/** Wraps `store` so every `writeCheckpoint` call is ALSO captured into `checkpoints`, in order -- `ReceiptStore.writeCheckpoint` replaces the prior stored checkpoint, so this is the only way to independently inspect BOTH the terminal-transition and final checkpoints a single `runTeardown` pass signs (D-31). */
function wrapCapturingCheckpoints(store: ReceiptStore): { store: ReceiptStore; checkpoints: Checkpoint[] } {
  const checkpoints: Checkpoint[] = [];
  const store2: ReceiptStore = {
    append: (chain, entry) => store.append(chain, entry),
    load: (chain) => store.load(chain),
    readCheckpoint: (chain) => store.readCheckpoint(chain),
    async writeCheckpoint(checkpoint) {
      checkpoints.push(checkpoint);
      await store.writeCheckpoint(checkpoint);
    },
  };
  return { store: store2, checkpoints };
}

/** Seeds one `attested_claim` entry directly onto `store`'s attested chain -- proving teardown (and step 4 in particular) never touches the attested chain, which has no production writer of its own in this phase. */
async function seedAttestedEntry(store: ReceiptStore): Promise<void> {
  const entry = appendEntry(
    [],
    {
      chain: "attested",
      type: "attested_claim",
      payload: { publisherId: "pub-1", kid: "key-1", claimType: "usage", claimHash: "jcs-sha256:bb", sig: "sig" },
    },
    NOW,
  );
  await store.append("attested", entry);
}

interface Scenario {
  readonly deps: TeardownDeps;
  readonly leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  readonly rawReceiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  readonly checkpoints: Checkpoint[];
  readonly publicKey: CryptoKey;
  readonly vault: CredentialVault;
  readonly custody: LicenseCustody & { seed(leaseId: string, license: HeldLicense): void };
}

/**
 * Builds a full-fidelity scenario: a lease starting directly in a terminal
 * end state (`state` override), a real vault with ONE seeded credential, a
 * real `MockLicenseIssuer` + custody with ONE held license, and a real
 * cleanup-hook HTTP endpoint -- so ALL 5 default steps run their REAL
 * implementation, never a happy-path placeholder. `signingKey` is always
 * supplied (D-31 bracketing).
 */
async function buildScenario(
  leaseId: string,
  state: Lease["state"],
  harness: MockAuthHarness,
  cleanupUrl: string | null,
  cleanupTimeoutMs?: number,
): Promise<Scenario> {
  const leaseStore = createInMemoryLeaseStore();
  const rawReceiptStore = createInMemoryReceiptStore();
  const { store: receiptStore, checkpoints } = wrapCapturingCheckpoints(rawReceiptStore);
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

  await seedAttestedEntry(receiptStore);

  const lease: Lease = makeTestLease(leaseId, { state });
  await leaseStore.save(lease);

  const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
  vault.seedCredential(leaseId, RESOURCE, {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiry: NOW + 3600,
    tokenEndpoint: "unused-in-this-test",
    resourceIndicator: RESOURCE,
  });

  const issuer = await createMockLicenseIssuer();
  const custody = createInMemoryLicenseCustody();
  custody.seed(leaseId, await mintTestHeldLicense(issuer, leaseId));

  const steps = createDefaultTeardownSteps(
    receiptStore,
    privateKey,
    vault,
    { issuer, custody },
    { url: cleanupUrl, ...(cleanupTimeoutMs === undefined ? {} : { timeoutMs: cleanupTimeoutMs }) },
  );

  const deps: TeardownDeps = { leaseStore, receiptStore, leaseId, steps, signingKey: privateKey };

  return { deps, leaseStore, rawReceiptStore, checkpoints, publicKey, vault, custody };
}

describe("teardown-receipts-survive (RCPT-07, D-17, D-31)", () => {
  let harness: MockAuthHarness;
  let cleanupServer: TestServer;

  beforeEach(async () => {
    harness = await startMockAuthServer();
    cleanupServer = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
  });

  afterEach(async () => {
    await harness.stop();
    await cleanupServer.close();
  });

  describe("RCPT-07: both chains survive cleanup and remain verifiable", () => {
    it("after cleaned_up, the verified chain (including the final signed receipt) verifies, and the attested chain verifies independently", async () => {
      const leaseId = "lease-rcpt07-chains";
      const scenario = await buildScenario(leaseId, "completed", harness, cleanupServer.url);

      const finalLease = await runTeardown(scenario.deps, NOW);
      expect(finalLease.state).toBe("cleaned_up");

      const verifiedChain = await scenario.rawReceiptStore.load("verified");
      const verifiedResult = await verifyChain(verifiedChain);
      expect(verifiedResult.ok).toBe(true);

      const finalCheckpoint = await scenario.rawReceiptStore.readCheckpoint("verified");
      expect(finalCheckpoint).toBeDefined();
      if (finalCheckpoint === undefined) return;
      const anchored = await verifyChain(verifiedChain, finalCheckpoint, scenario.publicKey);
      expect(anchored.ok).toBe(true);

      // The attested chain -- never touched by teardown -- still loads and
      // verifies independently of the verified chain's own result.
      const attestedChain = await scenario.rawReceiptStore.load("attested");
      expect(attestedChain).toHaveLength(1);
      const attestedResult = await verifyChain(attestedChain);
      expect(attestedResult.ok).toBe(true);
    });
  });

  describe("D-17: lease + progress survive; vault credential + license custody are gone", () => {
    it("after cleaned_up, the lease + teardownProgress still load(); the vault holds no credential and custody has no license", async () => {
      const leaseId = "lease-rcpt07-retain-delete";
      const scenario = await buildScenario(leaseId, "completed", harness, cleanupServer.url);

      await runTeardown(scenario.deps, NOW);

      const reloaded = await scenario.leaseStore.load(leaseId);
      expect(reloaded).toBeDefined();
      expect(reloaded?.state).toBe("cleaned_up");
      expect(reloaded?.teardownProgress).toEqual({
        revoke_oauth: "revoked",
        invalidate_license: "ok",
        cleanup_hook: "attested_ok",
        delete_cached_data: "ok",
        final_receipt: "ok",
      });

      await expect(scenario.vault.resolveAccessToken(leaseId, RESOURCE, NOW)).rejects.toThrow();
      expect(scenario.custody.hasLicense(leaseId)).toBe(false);
    });
  });

  describe("cleanup_incomplete: lease + progress survive for retry, receipts still verify", () => {
    it("a failing cleanup hook lands cleanup_incomplete honestly; the lease + progress still load() and the receipts still verify, and a retry can still resume to cleaned_up", async () => {
      const leaseId = "lease-rcpt07-incomplete";
      // Port 1: nothing listens there -- a genuine network failure, forcing
      // cleanup_hook (step 3) to fail while every other real step succeeds.
      const scenario = await buildScenario(leaseId, "revoked", harness, "http://127.0.0.1:1", 500);

      const incomplete = await runTeardown(scenario.deps, NOW);
      expect(incomplete.state).toBe("cleanup_incomplete");

      const reloaded = await scenario.leaseStore.load(leaseId);
      expect(reloaded).toBeDefined();
      expect(reloaded?.state).toBe("cleanup_incomplete");
      expect(reloaded?.teardownProgress?.cleanup_hook).toBe("failed");
      expect(reloaded?.teardownProgress?.revoke_oauth).toBe("revoked");
      expect(reloaded?.teardownProgress?.delete_cached_data).toBe("ok");
      expect(reloaded?.teardownProgress?.final_receipt).toBe("ok");

      const chainAfterFirstPass = await scenario.rawReceiptStore.load("verified");
      const resultAfterFirstPass = await verifyChain(chainAfterFirstPass);
      expect(resultAfterFirstPass.ok).toBe(true);

      // A retry with a working cleanup endpoint resumes from persisted
      // progress (D-14) and can still reach cleaned_up -- proving the lease
      // + progress record genuinely survived for this purpose.
      const retrySteps = createDefaultTeardownSteps(
        scenario.deps.receiptStore,
        (await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })).privateKey,
        undefined,
        undefined,
        { url: cleanupServer.url },
      );
      const retryDeps: TeardownDeps = { ...scenario.deps, steps: retrySteps };
      const cleaned = await retryTeardown(retryDeps, "user", NOW + 10);
      expect(cleaned.state).toBe("cleaned_up");

      const chainAfterRetry = await scenario.rawReceiptStore.load("verified");
      const resultAfterRetry = await verifyChain(chainAfterRetry);
      expect(resultAfterRetry.ok).toBe(true);
    });
  });

  describe("D-31: checkpoints bracket the ending", () => {
    it("signs a checkpoint at the terminal transition and a final checkpoint after step 5, both independently verifying via verifyCheckpoint", async () => {
      const leaseId = "lease-rcpt07-bracketing";
      const scenario = await buildScenario(leaseId, "completed", harness, cleanupServer.url);

      const finalLease = await runTeardown(scenario.deps, NOW);
      expect(finalLease.state).toBe("cleaned_up");

      expect(scenario.checkpoints).toHaveLength(2);
      const [terminalCheckpoint, finalCheckpoint] = scenario.checkpoints;
      expect(terminalCheckpoint).toBeDefined();
      expect(finalCheckpoint).toBeDefined();
      if (terminalCheckpoint === undefined || finalCheckpoint === undefined) return;

      // The terminal-transition checkpoint anchors just the begin_teardown
      // receipt (the lease was constructed directly in a terminal end
      // state, so runTeardown's own auto-chain produced exactly one
      // transition receipt before this checkpoint was signed).
      expect(terminalCheckpoint.chain).toBe("verified");
      expect(terminalCheckpoint.count).toBe(1);
      expect(await verifyCheckpoint(terminalCheckpoint, scenario.publicKey)).toBe(true);

      // final_receipt (step 5) signs its own checkpoint over the chain as it
      // stands BEFORE its own teardown_step receipt is appended: 1
      // begin_teardown + 2 revoke_oauth receipts (the real step appends one
      // PER credential, here 1, plus runStepAndPersist's own aggregate
      // receipt) + 3 more step receipts (invalidate_license, cleanup_hook,
      // delete_cached_data) = 6 entries.
      expect(finalCheckpoint.chain).toBe("verified");
      expect(finalCheckpoint.count).toBe(6);
      expect(await verifyCheckpoint(finalCheckpoint, scenario.publicKey)).toBe(true);

      // The store's single checkpoint slot per chain holds the LAST one
      // written (the final checkpoint) -- but the terminal-transition
      // checkpoint remains independently verifiable from the captured
      // value above, even though it is no longer the "current" one.
      const stored = await scenario.rawReceiptStore.readCheckpoint("verified");
      expect(stored).toEqual(finalCheckpoint);
    });

    it("a checkpoint bracket is still signed when the caller already chained the terminal transition + begin_teardown before calling runTeardown (the production call shape)", async () => {
      const leaseId = "lease-rcpt07-bracketing-already-tearing-down";
      const scenario = await buildScenario(leaseId, "tearing_down", harness, cleanupServer.url);

      const finalLease = await runTeardown(scenario.deps, NOW);
      expect(finalLease.state).toBe("cleaned_up");

      // No terminal-state auto-chain fires (the lease already arrived
      // tearing_down, mirroring revocation.ts/completeViaVerifier's
      // production call shape) -- but the bracketing checkpoint still signs
      // right before the fixed steps run, over whatever chain state exists
      // at that point (empty, in this fixture).
      expect(scenario.checkpoints).toHaveLength(2);
      const [terminalCheckpoint, finalCheckpoint] = scenario.checkpoints;
      expect(terminalCheckpoint).toBeDefined();
      expect(finalCheckpoint).toBeDefined();
      if (terminalCheckpoint === undefined || finalCheckpoint === undefined) return;
      expect(terminalCheckpoint.count).toBe(0);
      expect(await verifyCheckpoint(terminalCheckpoint, scenario.publicKey)).toBe(true);
      // No begin_teardown receipt this time (see above) -- 2 revoke_oauth
      // receipts + 3 more step receipts = 5 entries before final_receipt
      // appends its own.
      expect(finalCheckpoint.count).toBe(5);
      expect(await verifyCheckpoint(finalCheckpoint, scenario.publicKey)).toBe(true);
    });
  });
});
