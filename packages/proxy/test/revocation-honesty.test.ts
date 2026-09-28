/**
 * TEAR-02 honesty matrix (05-04). Task 1: `revokeCredential`'s structural
 * RFC 7009 tri-state in isolation (no vault, no teardown step) -- the
 * absent-endpoint case never makes an HTTP call, the 2xx case is never
 * upgraded beyond `revoked`, and any thrown error collapses to `failed`
 * without leaking a raw cause. Task 2 extends this file with the
 * vault-level revoke-and-discard proof + the real step-1 teardown
 * implementation (D-22, D-23, D-33). Task 3 completes it with the full
 * Pitfall-5 end-to-end matrix (2xx-without-revoking, absent-endpoint,
 * erroring-endpoint) through step 1, asserting secretless receipts.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as oauth from "oauth4webapi";

import type { Lease } from "@stint/core";
import { createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import { revokeCredential } from "../src/vault/oauth-client.js";
import type { OAuthClient } from "../src/vault/oauth-client.js";
import { createCredentialVault } from "../src/vault/credential-vault.js";
import type { CredentialVault } from "../src/vault/credential-vault.js";
import { createDefaultTeardownSteps } from "../src/teardown/steps.js";
import type { TeardownStep } from "../src/teardown/steps.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;

/** Extracts the named step from a `createDefaultTeardownSteps` array -- mirrors `teardown-fault-matrix.test.ts`'s own idiom for driving one step in isolation. */
function stepByName(steps: readonly TeardownStep[], name: TeardownStep["name"]): TeardownStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`test setup: no TeardownStep named "${name}".`);
  }
  return step;
}

async function buildRevokeOauthStep(
  vault: CredentialVault,
): Promise<{ step: TeardownStep; receiptStore: ReturnType<typeof createInMemoryReceiptStore>; signingKey: CryptoKey }> {
  const receiptStore = createInMemoryReceiptStore();
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const steps = createDefaultTeardownSteps(receiptStore, privateKey, vault);
  return { step: stepByName(steps, "revoke_oauth"), receiptStore, signingKey: privateKey };
}

/** An `OAuthClient` whose AS metadata has NO `revocation_endpoint` at all -- the D-20 structural distinguisher. Only `issuer` is required by `oauth.AuthorizationServer`. */
function makeAbsentEndpointClient(): OAuthClient {
  return {
    as: { issuer: "https://as.revocation-honesty-test.example" },
    client: { client_id: "revocation-honesty-test-client" },
    clientAuth: oauth.None(),
  };
}

/**
 * An `OAuthClient` whose `revocation_endpoint` points at a loopback address
 * with no listener (port 1 -- connecting, unlike binding, needs no
 * privilege, and nothing listens there), so any revoke attempt fails fast
 * with a real network error -- constructed directly, per the plan, rather
 * than forcing the mock AS's own always-200 `/revoke`.
 */
function makeErroringEndpointClient(): OAuthClient {
  return {
    as: {
      issuer: "https://as.revocation-honesty-test.example",
      revocation_endpoint: "http://127.0.0.1:1/revoke",
    },
    client: { client_id: "revocation-honesty-test-client" },
    clientAuth: oauth.None(),
  };
}

describe("revokeCredential: structural RFC 7009 tri-state (D-20, Pitfall 5, TEAR-02)", () => {
  it("returns discarded_revocation_unsupported and makes NO HTTP call when as.revocation_endpoint is undefined", async () => {
    const client = makeAbsentEndpointClient();
    // No `fetch` stub/spy needed: the structural check must short-circuit
    // before any network call is even attempted -- if it did not, hitting
    // `https://as.revocation-honesty-test.example` (a non-routable, non-existent
    // host) would reject with a network error instead of resolving cleanly.
    const result = await revokeCredential(client, "refresh-token-absent-endpoint");

    expect(result).toEqual({ kind: "discarded_revocation_unsupported" });
  });

  describe("against a mock AS with a revocation_endpoint", () => {
    let harness: MockAuthHarness;

    beforeEach(async () => {
      harness = await startMockAuthServer();
    });

    afterEach(async () => {
      await harness.stop();
    });

    it("returns revoked (and nothing stronger) on a 2xx response", async () => {
      expect(harness.oauthClient.as.revocation_endpoint).toBeDefined();

      const result = await revokeCredential(harness.oauthClient, "refresh-token-2xx", {
        allowInsecureRequests: true,
      });

      expect(result).toEqual({ kind: "revoked" });
    });
  });

  it("returns failed (error collapsed, no raw error leaked) when the revoke endpoint errors", async () => {
    const client = makeErroringEndpointClient();

    const result = await revokeCredential(client, "refresh-token-erroring", {
      allowInsecureRequests: true,
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    // The classified result itself never carries a raw error STRING for a
    // receipt to accidentally serialize -- `cause` is the caught value for
    // local diagnostics only; callers (teardown step 1) must never forward
    // it to a receipt (Pitfall 8, proven end-to-end in Task 3).
    expect(result.cause).toBeDefined();
  });
});

// --- Task 2: vault revoke-and-discard + real teardown step 1 --------------
// (D-22, D-23, D-33)

const RESOURCE = "inbox";

function seedTestCredential(vault: CredentialVault, leaseId: string): void {
  vault.seedCredential(leaseId, RESOURCE, {
    accessToken: "access-token-should-never-appear-in-a-receipt",
    refreshToken: "refresh-token-should-never-appear-in-a-receipt",
    expiry: NOW + 3600,
    tokenEndpoint: "unused-in-these-tests",
    resourceIndicator: RESOURCE,
  });
}

describe("teardown step 1 (revoke_oauth): real implementation over the vault (D-22, D-23, D-33)", () => {
  describe("a lease with one seeded credential + a supporting AS", () => {
    let harness: MockAuthHarness;

    beforeEach(async () => {
      harness = await startMockAuthServer();
    });

    afterEach(async () => {
      await harness.stop();
    });

    it("records step-1 outcome revoked and the credential entry is gone from the vault afterward", async () => {
      const leaseId = "lease-step1-revoked";
      const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
      seedTestCredential(vault, leaseId);
      const { step } = await buildRevokeOauthStep(vault);
      const lease: Lease = makeTestLease(leaseId);

      const outcome = await step.run(lease, NOW);

      expect(outcome).toBe("revoked");
      // The credential is discarded -- resolveAccessToken now rejects
      // ("no credential seeded"), the only externally-observable proof the
      // vault's custody boundary (D-04) permits.
      await expect(vault.resolveAccessToken(leaseId, RESOURCE, NOW)).rejects.toThrow();
    });
  });

  it("a lease whose revoke is structurally unsupported records discarded_revocation_unsupported AND the credential is STILL discarded (D-22)", async () => {
    const leaseId = "lease-step1-unsupported";
    const client = makeAbsentEndpointClient();
    const vault = createCredentialVault(client, () => NOW);
    seedTestCredential(vault, leaseId);
    const { step } = await buildRevokeOauthStep(vault);
    const lease: Lease = makeTestLease(leaseId);

    const outcome = await step.run(lease, NOW);

    expect(outcome).toBe("discarded_revocation_unsupported");
    await expect(vault.resolveAccessToken(leaseId, RESOURCE, NOW)).rejects.toThrow();
  });

  it("a lease whose revoke fails records failed AND the credential is STILL discarded (D-22)", async () => {
    const leaseId = "lease-step1-failed";
    const client = makeErroringEndpointClient();
    const vault = createCredentialVault(client, () => NOW, { allowInsecureRequests: true });
    seedTestCredential(vault, leaseId);
    const { step } = await buildRevokeOauthStep(vault);
    const lease: Lease = makeTestLease(leaseId);

    const outcome = await step.run(lease, NOW);

    expect(outcome).toBe("failed");
    await expect(vault.resolveAccessToken(leaseId, RESOURCE, NOW)).rejects.toThrow();
  });

  it("a lease with no seeded credential records not_applicable and makes no revoke call", async () => {
    const leaseId = "lease-step1-hosted-only";
    // Deliberately an unreachable client -- if the step incorrectly attempted
    // a revoke call despite no seeded credential, this would surface as
    // "failed" (a network error), not "not_applicable"; using an unreachable
    // AS here makes that mistake visible instead of silently passing.
    const client = makeErroringEndpointClient();
    const vault = createCredentialVault(client, () => NOW, { allowInsecureRequests: true });
    const { step } = await buildRevokeOauthStep(vault);
    const lease: Lease = makeTestLease(leaseId);

    const outcome = await step.run(lease, NOW);

    expect(outcome).toBe("not_applicable");
  });

  it("after step 1 discards the credential, a second attempt (retry) finds none and does not re-attempt revocation (D-23)", async () => {
    const leaseId = "lease-step1-retry-terminal";
    const harness = await startMockAuthServer();
    try {
      const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
      seedTestCredential(vault, leaseId);
      const { step } = await buildRevokeOauthStep(vault);
      const lease: Lease = makeTestLease(leaseId);

      const firstOutcome = await step.run(lease, NOW);
      expect(firstOutcome).toBe("revoked");
      const hitsAfterFirst = harness.tokenEndpointHits;

      // A second pass over the SAME step/vault -- the credential is already
      // gone, so this finds zero entries and returns not_applicable WITHOUT
      // ever invoking revokeCredential (and therefore without any new
      // network call to the AS) again.
      const secondOutcome = await step.run(lease, NOW + 10);

      expect(secondOutcome).toBe("not_applicable");
      expect(harness.tokenEndpointHits).toBe(hitsAfterFirst);
    } finally {
      await harness.stop();
    }
  });
});
