/**
 * The hybrid HAPPY PATH end to end (E2E-01, E2E-02): the whole real stack in one
 * process. acquire (PKCE vs the mock AS) -> license issued and held -> Paystack
 * read through the injected token -> orders write (approved) -> verifyOutcome ->
 * completed -> teardown -> `cleaned_up`, all through the shipped proxy, vault,
 * teardown and receipts. The adapter only proposes; core owns every deny.
 *
 * It also pins the security invariants the example exists to demonstrate: no
 * access token and no `v4.public.` license in anything the agent can see or in any
 * receipt (RCPT-01, PRXY-06, T-07-SECRETS), the license never at a customer
 * service (LIC-05), offline-verifiable license custody and a refresh that can never
 * outlive the lease (LIC-02, LIC-03), and completion by the verifier only (D-15).
 *
 * Every server binds loopback port 0 and is stopped inside `runScenario`; the
 * per-scenario temp dirs are removed in `afterAll`. No sleeps.
 */

import { verifyLicense } from "@stint/core";
import { importLicensePublicKey } from "@stint/core/license-issuer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertNoLicenseLeak } from "../src/mocks/services.js";
import { runScenario, SCENARIO_NOW } from "../src/scenario.js";
import type { ScenarioConfig, ScenarioResult } from "../src/scenario.js";

const disposers: Array<() => Promise<void>> = [];

async function scenario(config: ScenarioConfig = {}): Promise<ScenarioResult> {
  const result = await runScenario(config);
  disposers.push(result.dispose);
  return result;
}

afterAll(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const LICENSE_MARKER = "v4.public.";
const COMPLETION_TOOL_NAME = /verify|complete|done|finish|end_lease|close/i;

/** Every scanned surface must be free of every secret-shaped value and of the license marker. */
function expectNoSecrets(surface: string, secrets: readonly string[]): void {
  expect(surface).not.toContain(LICENSE_MARKER);
  for (const secret of secrets) expect(surface).not.toContain(secret);
}

describe("hybrid happy path", () => {
  let run: ScenarioResult;

  beforeAll(async () => {
    run = await scenario();
  });

  it("runs acquire -> license -> governed calls -> approved write -> verifier -> cleaned_up", () => {
    expect(run.exitCodes.create).toBe(0);
    expect(run.lease?.state).toBe("cleaned_up");

    // Every agent call succeeded (the approved write included).
    expect(run.results).toHaveLength(3);
    for (const result of run.results) expect(result.isError).not.toBe(true);

    // Each customer service got exactly the authorized traffic the script implies.
    const bearer = (request: { authorization: string | undefined }): boolean =>
      request.authorization?.startsWith("Bearer ") === true &&
      request.authorization.length > "Bearer ".length;
    expect(run.paystackRequests).toHaveLength(1);
    expect(run.paystackRequests.every(bearer)).toBe(true);
    // Sheet: one agent read, one approved write, one verifier read.
    expect(run.sheetsRequests.map((request) => request.kind)).toEqual(["read", "write", "read"]);
    expect(run.sheetsRequests.every(bearer)).toBe(true);
    expect(run.sheetsRows.find((row) => row.order_id === "ord_1001")?.status).toBe("reconciled");

    // The scripted adapter was asked once, for the irreversible write only.
    expect(run.approvalRequests.map((request) => request.binding.tool)).toEqual([
      "mark_order_reconciled",
    ]);

    // The merged timeline is non-empty and ends in the terminal state.
    expect(run.timeline.length).toBeGreaterThan(0);
    const last = run.timeline[run.timeline.length - 1];
    expect(last?.origin).toBe("verified");
    expect(last?.entry.type).toBe("transition");
    if (last?.entry.type === "transition") expect(last.entry.payload.to).toBe("cleaned_up");
  });

  it("never leaks an access token or a license into anything the agent sees, a receipt, the CLI output or the store", async () => {
    // The scan has teeth: it covers the real bearer tokens the services received, not just licenses.
    const bearers = run.paystackRequests.map((request) => request.authorization?.slice(7) ?? "");
    expect(bearers.every((token) => token !== "" && run.secrets.includes(token))).toBe(true);
    expect(run.secrets.some((secret) => !secret.startsWith(LICENSE_MARKER))).toBe(true);
    expectNoSecrets(JSON.stringify(run.results), run.secrets);
    expectNoSecrets(JSON.stringify(run.toolNames), run.secrets);
    expectNoSecrets(JSON.stringify([run.verifiedReceipts, run.attestedReceipts]), run.secrets);
    expectNoSecrets(run.cliOutput, run.secrets);
    expectNoSecrets(await run.readStoreText(), run.secrets);
  });

  it("sends the license to no customer service, only the OAuth access token (LIC-05)", () => {
    assertNoLicenseLeak(run.paystackRequests, run.sheetsRequests);
    // The license did flow, but only to the publisher that issued it.
    expect(run.publisher.issuedTokens.length).toBeGreaterThan(0);
    expect(run.publisher.issueHits).toBeGreaterThanOrEqual(1);
  });

  it("holds a license that verifies offline against the publisher's pinned key (LIC-02)", async () => {
    const publicKey = await importLicensePublicKey(run.licensePublicKey);
    expect(run.publisher.issuedTokens.length).toBeGreaterThanOrEqual(2);
    for (const token of run.publisher.issuedTokens) {
      expect(token.startsWith(LICENSE_MARKER)).toBe(true);
      const verified = await verifyLicense(
        publicKey,
        token,
        run.leaseId,
        run.manifest.spec_version,
        SCENARIO_NOW,
      );
      expect(verified.ok).toBe(true);
      if (!verified.ok) continue;
      expect(verified.value.claims.lease_id).toBe(run.leaseId);
      // Never outlives the lease it was issued for (LIC-03).
      expect(verified.value.expEpochSeconds).toBeLessThanOrEqual(run.lease?.expiresAt ?? 0);
    }
    // Only the license for THIS lease exists, and teardown told the publisher to drop it.
    expect(run.publisher.invalidatedLeaseIds).toEqual([run.leaseId]);
  });

  it("is completed by the verifier alone: no completion tool is exposed and the transition actor is verifier (D-15)", () => {
    expect([...run.toolNames].sort()).toEqual([
      "list_transactions",
      "mark_order_reconciled",
      "read_orders",
    ]);
    for (const name of run.toolNames) expect(name).not.toMatch(COMPLETION_TOOL_NAME);

    const transitions = run.verifiedReceipts.flatMap((entry) =>
      entry.type === "transition" ? [entry.payload] : [],
    );
    const completed = transitions.filter((t) => t.to === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.actor).toBe("verifier");
    expect(completed[0]?.event).toBe("outcome_verified");
    // The agent is never the actor of any transition.
    expect(transitions.every((t) => t.actor !== "agent")).toBe(true);
  });

  it("records all five teardown steps honestly and every chain verifies (D-12, D-19)", async () => {
    expect(run.lease?.teardownProgress).toEqual({
      revoke_oauth: "revoked",
      invalidate_license: "ok",
      cleanup_hook: "attested_ok",
      delete_cached_data: "ok",
      final_receipt: "ok",
    });

    // The attested-ok marker and the verified-chain entries are both in the merged timeline.
    expect(run.timeline.some((item) => item.origin === "verified")).toBe(true);
    expect(
      run.timeline.some(
        (item) =>
          item.entry.type === "teardown_step" &&
          item.entry.payload.step === "cleanup_hook" &&
          item.entry.payload.outcome === "attested_ok",
      ),
    ).toBe(true);

    // The publisher saw exactly one accepted, single-use cleanup call and one invalidation.
    expect(run.publisher.cleanupHits).toBe(1);
    expect(run.publisher.seenJtis).toHaveLength(1);
    expect(run.publisher.invalidateHits).toBe(1);
    expect(run.as.revokeHits).toBeGreaterThanOrEqual(1);

    // `stint verify` passed inside the scenario and passes again over the final store.
    expect(run.exitCodes.verify).toBe(0);
    const verify = await run.cli(["verify", run.leaseId]);
    expect(verify.code).toBe(0);

    // The human-readable timeline labels verified entries.
    const receipts = await run.cli(["receipts", run.leaseId]);
    expect(receipts.code).toBe(0);
    expect(receipts.out).toContain("[verified]");
  });
});

describe("license refresh is bounded by the lease (LIC-03, T-07-CLOCK)", () => {
  it("reissues before the TTL elapses and clamps the last reissue to the lease expiry", async () => {
    const run = await scenario({
      forceShortAccessTokenLifetime: true,
      script: [
        { name: "read_orders" },
        {
          // Past `exp - refreshBefore` of the 300s license, and past the 1s paystack token.
          name: "list_transactions",
          before: ({ clock }) => {
            clock.advance(250);
          },
        },
        {
          // Near the end of the lease: an unclamped reissue would expire after the lease does.
          name: "mark_order_reconciled",
          arguments: { order_id: "ord_1001", status: "reconciled" },
          before: ({ clock, manifest }) => {
            clock.now = SCENARIO_NOW + manifest.lease.max_duration_seconds - 100;
          },
        },
      ],
    });

    expect(run.lease?.state).toBe("cleaned_up");
    for (const result of run.results) expect(result.isError).not.toBe(true);

    // The expired paystack token refreshed over the real loopback AS (2 acquisitions + >= 1 refresh).
    expect(run.as.tokenEndpointHits).toBeGreaterThanOrEqual(3);

    // create + run start issued; two per-call refreshes reissued.
    expect(run.publisher.issueHits).toBe(2);
    expect(run.publisher.reissueHits).toBe(2);

    const expiresAt = run.lease?.expiresAt ?? 0;
    expect(expiresAt).toBe(SCENARIO_NOW + run.manifest.lease.max_duration_seconds);
    const publicKey = await importLicensePublicKey(run.licensePublicKey);
    const issuedAt = [SCENARIO_NOW, SCENARIO_NOW, SCENARIO_NOW + 250, expiresAt - 100];
    const exps: number[] = [];
    for (const [index, token] of run.publisher.issuedTokens.entries()) {
      const verified = await verifyLicense(
        publicKey,
        token,
        run.leaseId,
        run.manifest.spec_version,
        issuedAt[index] ?? SCENARIO_NOW,
      );
      expect(verified.ok).toBe(true);
      if (verified.ok) exps.push(verified.value.expEpochSeconds);
    }
    expect(exps).toHaveLength(4);
    // No license, refreshed or not, outlives the lease.
    for (const exp of exps) expect(exp).toBeLessThanOrEqual(expiresAt);
    // The first three follow the 300s TTL; the last would have been expiresAt + 200 unclamped.
    expect(exps.slice(0, 3)).toEqual([SCENARIO_NOW + 300, SCENARIO_NOW + 300, SCENARIO_NOW + 550]);
    expect(exps[3]).toBe(expiresAt);

    // Even a refreshed license reaches no service and no secret leaks.
    assertNoLicenseLeak(run.paystackRequests, run.sheetsRequests);
    expectNoSecrets(JSON.stringify(run.results), run.secrets);
  });
});

describe("the agent cannot complete its own lease (D-15, LIFE-06)", () => {
  it("guessed completion tools are denied and the lease stays active", async () => {
    const run = await scenario({
      end: "none",
      script: [
        { name: "list_transactions" },
        { name: "complete_lease" },
        { name: "verify_outcome" },
        { name: "done", arguments: { success: true } },
      ],
    });

    expect(run.results[0]?.isError).not.toBe(true);
    for (const result of run.results.slice(1)) expect(result.isError).toBe(true);
    for (const name of run.toolNames) expect(name).not.toMatch(COMPLETION_TOOL_NAME);

    // Nothing the agent said moved the lease, and no `completed` transition exists.
    expect(run.lease?.state).toBe("active");
    expect(
      run.verifiedReceipts.some(
        (entry) => entry.type === "transition" && entry.payload.to === "completed",
      ),
    ).toBe(false);
    expectNoSecrets(JSON.stringify(run.results), run.secrets);
  });
});
