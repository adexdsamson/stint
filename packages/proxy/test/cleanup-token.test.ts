/**
 * TEAR-03: the cleanup token (D-08 to D-13) and the real `cleanup_hook`
 * (step 3) implementation.
 *
 * Task 2 covers: `mintCleanupToken`'s claim shape (scope/jti/iat/exp, EdDSA
 * header, verifiable with the matching public key), fresh-jti-per-attempt
 * (D-10), and the step's honest outcome mapping (2xx -> `attested_ok`,
 * non-2xx/network/timeout -> `failed`, `null` cleanup -> `not_applicable`
 * with no HTTP call attempted).
 *
 * Task 3 extends this file with the cleanup-hook fault + retry path through
 * the real orchestrator (`runTeardown`/`retryTeardown`): a failing hook
 * lands `cleanup_incomplete`, and a retry mints a FRESH token (never
 * re-presents the failed attempt's token, D-10) that can succeed ->
 * `cleaned_up`. It also asserts the `spec/ALP.md` §10 cleanup-token-format
 * `[OPEN: Phase 5]` marker this plan closes (D-26) is gone.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair, jwtVerify } from "jose";
import type { CryptoKey } from "jose";
import { describe, expect, it } from "vitest";

import type { Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import {
  CLEANUP_TOKEN_TTL_SECONDS,
  createDefaultTeardownSteps,
  mintCleanupToken,
  retryTeardown,
  runTeardown,
  verifyCleanupToken,
} from "../src/index.js";
import type { TeardownDeps, TeardownStep } from "../src/index.js";

const NOW = 1_700_000_000;

async function generateEdDsaKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  return generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
}

function cleanupHookStepFrom(steps: readonly TeardownStep[]): TeardownStep {
  const step = steps.find((candidate) => candidate.name === "cleanup_hook");
  if (step === undefined) {
    throw new Error("no cleanup_hook step registered");
  }
  return step;
}

interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

/** A real loopback HTTP server -- the cleanup client (`postCleanupToken`) makes a genuine network call against it, never a mocked `fetch`. */
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

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.replace(/^Bearer /, "");
}

// --- Task 2: mintCleanupToken / verifyCleanupToken (D-08, D-09, D-10) -----

describe("mintCleanupToken (D-08, D-09)", () => {
  it("produces a compact EdDSA JWT with scope cleanup:<leaseId>, jti, iat, exp; verifiable with the matching public key", async () => {
    const { privateKey, publicKey } = await generateEdDsaKeyPair();

    const token = await mintCleanupToken("lease-abc", "jti-1", NOW, privateKey);

    const { protectedHeader, payload } = await jwtVerify(token, publicKey, {
      algorithms: ["EdDSA"],
      currentDate: new Date(NOW * 1000),
    });
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(payload.scope).toBe("cleanup:lease-abc");
    expect(payload.jti).toBe("jti-1");
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + CLEANUP_TOKEN_TTL_SECONDS);
  });

  it("fails verification against a DIFFERENT key (never a hand-rolled check -- jose's own signature verification)", async () => {
    const { privateKey } = await generateEdDsaKeyPair();
    const { publicKey: wrongPublicKey } = await generateEdDsaKeyPair();

    const token = await mintCleanupToken("lease-abc", "jti-1", NOW, privateKey);

    await expect(jwtVerify(token, wrongPublicKey, { algorithms: ["EdDSA"] })).rejects.toThrow();
  });

  it("two mint calls for the same lease with different jti values produce two DIFFERENT tokens (fresh per attempt, D-10)", async () => {
    const { privateKey } = await generateEdDsaKeyPair();

    const tokenA = await mintCleanupToken("lease-abc", "jti-1", NOW, privateKey);
    const tokenB = await mintCleanupToken("lease-abc", "jti-2", NOW, privateKey);

    expect(tokenA).not.toBe(tokenB);
  });
});

describe("verifyCleanupToken (reference verify, fail-closed)", () => {
  it("returns the decoded claims for a valid token", async () => {
    const { privateKey, publicKey } = await generateEdDsaKeyPair();
    const token = await mintCleanupToken("lease-xyz", "jti-9", NOW, privateKey);

    const claims = await verifyCleanupToken(token, publicKey, NOW);

    expect(claims).toEqual({
      scope: "cleanup:lease-xyz",
      jti: "jti-9",
      iat: NOW,
      exp: NOW + CLEANUP_TOKEN_TTL_SECONDS,
    });
  });

  it("collapses a wrong-key failure to null -- never throws, never forwards jose's exception text (T-01-15, D-16)", async () => {
    const { privateKey } = await generateEdDsaKeyPair();
    const { publicKey: wrongPublicKey } = await generateEdDsaKeyPair();
    const token = await mintCleanupToken("lease-xyz", "jti-9", NOW, privateKey);

    await expect(verifyCleanupToken(token, wrongPublicKey)).resolves.toBeNull();
  });
});

// --- Task 2: real cleanup_hook step (D-08 to D-13) -------------------------

describe("cleanup_hook step (D-08 to D-13, TEAR-03)", () => {
  it("a cleanup hook returning 2xx -> attested_ok (D-12: attested, never over-trusted as verified)", async () => {
    const capturedTokens: string[] = [];
    const server = await startTestServer((req, res) => {
      capturedTokens.push(bearerToken(req));
      res.writeHead(200);
      res.end();
    });
    try {
      const { privateKey } = await generateEdDsaKeyPair();
      const receiptStore = createInMemoryReceiptStore();
      const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, { url: server.url });
      const step = cleanupHookStepFrom(steps);
      const lease: Lease = makeTestLease("lease-cleanup-ok", { state: "tearing_down" });

      const outcome = await step.run(lease, NOW);

      expect(outcome).toBe("attested_ok");
      expect(capturedTokens).toHaveLength(1);
      expect(capturedTokens[0]).not.toBe("");
    } finally {
      await server.close();
    }
  });

  it("a cleanup hook returning a non-2xx status -> failed", async () => {
    const server = await startTestServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    try {
      const { privateKey } = await generateEdDsaKeyPair();
      const receiptStore = createInMemoryReceiptStore();
      const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, { url: server.url });
      const step = cleanupHookStepFrom(steps);
      const lease: Lease = makeTestLease("lease-cleanup-500", { state: "tearing_down" });

      const outcome = await step.run(lease, NOW);

      expect(outcome).toBe("failed");
    } finally {
      await server.close();
    }
  });

  it("a cleanup hook with no listener (network failure) -> failed, never a raw error escapes", async () => {
    const { privateKey } = await generateEdDsaKeyPair();
    const receiptStore = createInMemoryReceiptStore();
    // Port 1: connecting (unlike binding) needs no privilege, and nothing listens there.
    const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, {
      url: "http://127.0.0.1:1",
      timeoutMs: 500,
    });
    const step = cleanupHookStepFrom(steps);
    const lease: Lease = makeTestLease("lease-cleanup-network-fail", { state: "tearing_down" });

    const outcome = await step.run(lease, NOW);

    expect(outcome).toBe("failed");
  });

  it("a cleanup hook that never responds -> failed once the client-side timeout elapses", async () => {
    const server = await startTestServer(() => {
      // Deliberately never call res.end() -- simulates an unresponsive hook.
    });
    try {
      const { privateKey } = await generateEdDsaKeyPair();
      const receiptStore = createInMemoryReceiptStore();
      const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, {
        url: server.url,
        timeoutMs: 100,
      });
      const step = cleanupHookStepFrom(steps);
      const lease: Lease = makeTestLease("lease-cleanup-timeout", { state: "tearing_down" });

      const outcome = await step.run(lease, NOW);

      expect(outcome).toBe("failed");
    } finally {
      await server.close();
    }
  });

  it("a null cleanup config -> not_applicable, and no token is minted / no HTTP call is attempted (D-13)", async () => {
    const { privateKey } = await generateEdDsaKeyPair();
    const receiptStore = createInMemoryReceiptStore();
    const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, { url: null });
    const step = cleanupHookStepFrom(steps);
    const lease: Lease = makeTestLease("lease-cleanup-null", { state: "tearing_down" });

    const outcome = await step.run(lease, NOW);

    // If the step had incorrectly tried to POST anywhere, it would resolve
    // "failed" (nothing is listening for this test) rather than
    // "not_applicable" -- this outcome alone proves no call was attempted.
    expect(outcome).toBe("not_applicable");
  });

  it("mints a FRESH jti per attempt -- two runs of the same step never reuse a token (D-10)", async () => {
    const capturedTokens: string[] = [];
    const server = await startTestServer((req, res) => {
      capturedTokens.push(bearerToken(req));
      res.writeHead(200);
      res.end();
    });
    try {
      const { privateKey, publicKey } = await generateEdDsaKeyPair();
      const receiptStore = createInMemoryReceiptStore();
      const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, { url: server.url });
      const step = cleanupHookStepFrom(steps);
      const lease: Lease = makeTestLease("lease-cleanup-fresh-jti", { state: "tearing_down" });

      await step.run(lease, NOW);
      await step.run(lease, NOW + 1);

      expect(capturedTokens).toHaveLength(2);
      expect(capturedTokens[0]).not.toBe(capturedTokens[1]);

      const claimsA = await verifyCleanupToken(capturedTokens[0] ?? "", publicKey, NOW);
      const claimsB = await verifyCleanupToken(capturedTokens[1] ?? "", publicKey, NOW);
      expect(claimsA).not.toBeNull();
      expect(claimsB).not.toBeNull();
      expect(claimsA?.jti).not.toBe(claimsB?.jti);
    } finally {
      await server.close();
    }
  });
});

// --- Task 3: cleanup-hook fault + retry through the real orchestrator -----

describe("cleanup-hook fault + retry through the orchestrator (D-26, TEAR-05)", () => {
  it("a cleanup hook that fails records step 3 failed and lands cleanup_incomplete; retrying mints a fresh token and can succeed -> cleaned_up", async () => {
    let requestCount = 0;
    const capturedTokens: string[] = [];
    const server = await startTestServer((req, res) => {
      requestCount += 1;
      capturedTokens.push(bearerToken(req));
      if (requestCount === 1) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });

    try {
      const leaseId = "lease-cleanup-fault-retry";
      const leaseStore = createInMemoryLeaseStore();
      const receiptStore = createInMemoryReceiptStore();
      const { privateKey, publicKey } = await generateEdDsaKeyPair();

      const lease: Lease = makeTestLease(leaseId, { state: "revoked" });
      await leaseStore.save(lease);

      const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, undefined, { url: server.url });
      const deps: TeardownDeps = { leaseStore, receiptStore, leaseId, steps };

      const incomplete = await runTeardown(deps, NOW);
      expect(incomplete.state).toBe("cleanup_incomplete");
      const beforeRetry = await leaseStore.load(leaseId);
      expect(beforeRetry?.teardownProgress?.cleanup_hook).toBe("failed");

      const cleaned = await retryTeardown(deps, "user", NOW + 10);
      expect(cleaned.state).toBe("cleaned_up");
      const afterRetry = await leaseStore.load(leaseId);
      expect(afterRetry?.teardownProgress?.cleanup_hook).toBe("attested_ok");

      // The retry's cleanup-hook attempt mints a genuinely FRESH token --
      // never re-presents the failed attempt's token (D-10).
      expect(capturedTokens).toHaveLength(2);
      expect(capturedTokens[0]).not.toBe(capturedTokens[1]);
      const claims0 = await verifyCleanupToken(capturedTokens[0] ?? "", publicKey, NOW);
      const claims1 = await verifyCleanupToken(capturedTokens[1] ?? "", publicKey, NOW);
      expect(claims0?.jti).not.toBe(claims1?.jti);
    } finally {
      await server.close();
    }
  });
});

// --- Task 3: spec/ALP.md §10 marker close (D-26) --------------------------

describe("spec/ALP.md §10 cleanup-token-format marker (D-26)", () => {
  it("no [OPEN: Phase 5] marker remains", () => {
    const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "spec", "ALP.md");
    const contents = readFileSync(specPath, "utf8");
    expect(contents).not.toContain("[OPEN: Phase 5]");
  });
});
