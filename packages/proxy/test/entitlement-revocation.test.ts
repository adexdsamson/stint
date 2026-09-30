/**
 * LIC-04 publisher entitlement revocation (05-05). Task 2: unit coverage for
 * `applyEntitlementRevocation` (`revocation.ts`) mirroring
 * `revocation-detection.test.ts`'s `applyProviderRevocation` coverage, and
 * the real teardown step 2 (`invalidate_license`) implementation (D-21,
 * D-33) built via `createDefaultTeardownSteps`'s optional `license`
 * parameter. Task 3 extends this file with the full end-to-end LIC-04 path:
 * `applyEntitlementRevocation` -> persisted `tearing_down` lease ->
 * `runTeardown` -> `cleaned_up`, proving the license was invalidated and
 * discarded, the credential was discarded, the revoke actor was `publisher`,
 * notify fired, and no secret ever reaches a receipt.
 */

import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLicenseToken } from "@stint/core";
import type { HeldLicense, Lease, LifecycleEvent } from "@stint/core";
import {
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createMockLicenseIssuer,
  makeTestLease,
} from "@stint/core/testing";
import type { MockLicenseIssuer } from "@stint/core/testing";

import { applyEntitlementRevocation } from "../src/revocation.js";
import { appendTransitionReceipt, runTeardown } from "../src/teardown/orchestrate.js";
import type { TeardownDeps } from "../src/teardown/orchestrate.js";
import { createDefaultTeardownSteps } from "../src/teardown/steps.js";
import type { LicenseCustody, TeardownStep } from "../src/teardown/steps.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";
import { createCredentialVault } from "../src/vault/credential-vault.js";

const NOW = 1_700_000_000;

// --- Task 2: applyEntitlementRevocation (unit) -----------------------------

describe("applyEntitlementRevocation (LIC-04, D-21): chains entitlement_revoked -> begin_teardown", () => {
  it("moves an active lease through entitlement_revoked (publisher) then begin_teardown (runtime), landing tearing_down", () => {
    const lease = makeTestLease("lease-entitlement-active", { state: "active" });

    const result = applyEntitlementRevocation(lease, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("tearing_down");

    const [entitlementRevoked, beginTeardown] = result.value.transitions;
    expect(entitlementRevoked.actor).toBe("publisher");
    expect(entitlementRevoked.event).toBe("entitlement_revoked");
    expect(entitlementRevoked.from).toBe("active");
    expect(entitlementRevoked.to).toBe("revoked");
    expect(beginTeardown.actor).toBe("runtime");
    expect(beginTeardown.event).toBe("begin_teardown");
    expect(beginTeardown.from).toBe("revoked");
    expect(beginTeardown.to).toBe("tearing_down");
  });

  it("moves a granted lease to tearing_down (the other legal entitlement_revoked source state)", () => {
    const lease = makeTestLease("lease-entitlement-granted", { state: "granted" });

    const result = applyEntitlementRevocation(lease, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("tearing_down");
    expect(result.value.transitions[0].actor).toBe("publisher");
    expect(result.value.transitions[1].actor).toBe("runtime");
  });

  it("returns reduce's illegal_transition rejection (not a throw) for a non-active/non-granted source state", () => {
    const lease = makeTestLease("lease-entitlement-illegal", { state: "cleaned_up" });

    const result = applyEntitlementRevocation(lease, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");
  });
});

// --- Task 2: real teardown step 2 (invalidate_license) --------------------

/** A simple in-memory `LicenseCustody` -- no production per-lease license store exists yet (steps.ts docstring); a Map-keyed-by-lease-id double is sufficient to exercise the real step. */
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

async function buildInvalidateLicenseStep(
  issuer: MockLicenseIssuer,
  custody: LicenseCustody,
): Promise<{ step: TeardownStep }> {
  const receiptStore = createInMemoryReceiptStore();
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const steps = createDefaultTeardownSteps(receiptStore, privateKey, undefined, { issuer, custody });
  const step = steps.find((candidate) => candidate.name === "invalidate_license");
  if (step === undefined) {
    throw new Error("test setup: no TeardownStep named \"invalidate_license\".");
  }
  return { step };
}

async function mintTestHeldLicense(issuer: MockLicenseIssuer, leaseId: string): Promise<HeldLicense> {
  return issuer.issue(
    { lease_id: leaseId, job: { description: "test job" }, limits: { max_actions: 10, actions_per_hour: null } },
    "alp/0.1",
    NOW,
    NOW + 3600,
  );
}

describe("teardown step 2 (invalidate_license): real implementation over LicenseIssuer + LicenseCustody (D-21, D-33)", () => {
  it("a hosted/hybrid lease with a held license invalidates + discards -> outcome ok, custody empty afterward", async () => {
    const leaseId = "lease-step2-hosted";
    const issuer = await createMockLicenseIssuer();
    const custody = createInMemoryLicenseCustody();
    custody.seed(leaseId, await mintTestHeldLicense(issuer, leaseId));
    const { step } = await buildInvalidateLicenseStep(issuer, custody);
    const lease: Lease = makeTestLease(leaseId);

    const outcome = await step.run(lease, NOW);

    expect(outcome).toBe("ok");
    expect(custody.hasLicense(leaseId)).toBe(false);

    // The invalidate call landed on the issuer too -- a subsequent reissue
    // for this lease is refused (D-21's refuse-reissue-after-invalidate).
    const reissued = await issuer.reissue(
      { lease_id: leaseId, job: { description: "test job" }, limits: { max_actions: 10, actions_per_hour: null } },
      "alp/0.1",
      NOW,
      NOW + 3600,
    );
    expect(reissued).toBeNull();
  });

  it("a delegated-only lease with no held license records not_applicable and never calls the issuer", async () => {
    const leaseId = "lease-step2-delegated-only";
    let invalidateCalled = false;
    const issuer: MockLicenseIssuer = {
      ...(await createMockLicenseIssuer()),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- this spy only needs to record that invalidate was called, never which lease id.
      invalidate(_leaseId: string): Promise<void> {
        invalidateCalled = true;
        return Promise.resolve();
      },
    };
    const custody = createInMemoryLicenseCustody();
    const { step } = await buildInvalidateLicenseStep(issuer, custody);
    const lease: Lease = makeTestLease(leaseId);

    const outcome = await step.run(lease, NOW);

    expect(outcome).toBe("not_applicable");
    expect(invalidateCalled).toBe(false);
  });
});

// --- Task 3: LIC-04 end-to-end (entitlement -> teardown -> license --------
// invalidated + discarded, credential discarded, secretless receipts) ------

const E2E_RESOURCE = "inbox";
const E2E_ACCESS_TOKEN = "access-token-lic04-must-never-leak";
const E2E_REFRESH_TOKEN = "refresh-token-lic04-must-never-leak";

describe("LIC-04 end-to-end: entitlement revocation -> teardown -> license + credential gone (Task 3)", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("a hosted/hybrid active lease with a held license + seeded credential reaches cleaned_up with the license invalidated, custody + credential gone, publisher actor, notify fired, and no secret in any receipt", async () => {
    const leaseId = "lease-lic04-e2e";
    const receiptStore = createInMemoryReceiptStore();
    const leaseStore = createInMemoryLeaseStore();

    // License side: a real HeldLicense minted for this lease, seeded into a
    // fresh LicenseCustody, plus a spy proving LicenseIssuer.invalidate was
    // actually called (not just custody-emptied by the test itself).
    const baseIssuer = await createMockLicenseIssuer();
    let invalidateCalled = false;
    const issuer: MockLicenseIssuer = {
      ...baseIssuer,
      invalidate(id: string): Promise<void> {
        invalidateCalled = true;
        return baseIssuer.invalidate(id);
      },
    };
    const custody = createInMemoryLicenseCustody();
    const heldLicense = await mintTestHeldLicense(issuer, leaseId);
    const licenseToken = readLicenseToken(heldLicense);
    custody.seed(leaseId, heldLicense);

    // Credential side: a real 2xx revoke over the loopback mock AS (D-20,
    // matching revocation-honesty.test.ts's happy path) so step 1 reaches
    // the SUCCESS outcome "revoked" and the overall run can reach
    // cleaned_up -- TEAR-02's own honesty matrix already covers the
    // unsupported/failed tri-state branches; this test only needs step 1 to
    // run and discard the credential alongside step 2's license work.
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(leaseId, E2E_RESOURCE, {
      accessToken: E2E_ACCESS_TOKEN,
      refreshToken: E2E_REFRESH_TOKEN,
      expiry: NOW + 3600,
      tokenEndpoint: "unused-in-this-test",
      resourceIndicator: E2E_RESOURCE,
    });

    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const steps = createDefaultTeardownSteps(receiptStore, privateKey, vault, { issuer, custody });

    const notified: LifecycleEvent[] = [];
    const notify = (event: LifecycleEvent): Promise<void> => {
      notified.push(event);
      return Promise.resolve();
    };

    // Start from an active lease, exactly like a real publisher-webhook call
    // site would: applyEntitlementRevocation computes the two transitions,
    // the caller persists the resulting tearing_down lease and receipts both
    // transitions BEFORE running the orchestrator in its own, later pass
    // (mirrors dispatch.ts's non-nested provider-revocation pattern, D-30).
    const activeLease = makeTestLease(leaseId, { state: "active" });
    await leaseStore.save(activeLease);

    const revocationResult = applyEntitlementRevocation(activeLease, NOW);
    expect(revocationResult.ok).toBe(true);
    if (!revocationResult.ok) return;
    expect(revocationResult.value.lease.state).toBe("tearing_down");
    const [entitlementRevoked, beginTeardown] = revocationResult.value.transitions;
    expect(entitlementRevoked.actor).toBe("publisher");
    expect(beginTeardown.actor).toBe("runtime");

    await leaseStore.save(revocationResult.value.lease);
    await appendTransitionReceipt(receiptStore, entitlementRevoked, NOW);
    await appendTransitionReceipt(receiptStore, beginTeardown, NOW);

    const deps: TeardownDeps = { leaseStore, receiptStore, leaseId, steps, notify };
    const finalLease = await runTeardown(deps, NOW + 1);

    expect(finalLease.state).toBe("cleaned_up");
    expect(invalidateCalled).toBe(true);
    expect(custody.hasLicense(leaseId)).toBe(false);
    // Step 1 (revoke_oauth) ran too -- the credential is gone from the vault.
    await expect(vault.resolveAccessToken(leaseId, E2E_RESOURCE, NOW + 1)).rejects.toThrow();

    expect(notified.some((event) => event.type === "cleaned_up")).toBe(true);

    const chain = await receiptStore.load("verified");
    const serializedChain = JSON.stringify(chain);
    expect(serializedChain).not.toContain(E2E_ACCESS_TOKEN);
    expect(serializedChain).not.toContain(E2E_REFRESH_TOKEN);
    expect(serializedChain).not.toContain(licenseToken);

    // The revoke leg's actor is publisher, verified independently from the
    // persisted receipt chain (not just the in-memory TransitionRecord).
    const entitlementRevokedEntry = chain.find(
      (entry) => entry.type === "transition" && entry.payload.event === "entitlement_revoked",
    );
    expect(entitlementRevokedEntry?.type).toBe("transition");
    if (entitlementRevokedEntry?.type === "transition") {
      expect(entitlementRevokedEntry.payload.actor).toBe("publisher");
    }
  });
});
