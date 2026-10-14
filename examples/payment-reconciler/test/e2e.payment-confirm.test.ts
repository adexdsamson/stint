/**
 * The PAYMENT-CONFIRMATION scenario end to end (PSTK-06): the whole real stack in
 * one process against a verify-capable mock Paystack on loopback, with NO
 * environment variable set. Consent collects the job's three fixed inputs through
 * the typed-entry seam while the API key arrives through the credentials-file
 * `api_key` entry carrying the mock's loopback origin (the interactive no-echo
 * prompt is covered by the CLI's own tests); the agent verifies; the USER runs
 * `stint-cli verify-outcome` and only that completes the lease; teardown ends
 * `cleaned_up` with the honest "not revoked upstream" caveat.
 *
 * Every verdict path is visible here: confirmed, amount_mismatch then recovery
 * (a failed check is not terminal), not_found, a transient 429 and 500, every
 * documented non-success status and the envelope trap. The fixture API key and
 * the fixture's hidden fields (e-mail, card authorization, IP, id) must appear in
 * nothing an agent, a receipt or the command output can show.
 *
 * Loopback port 0, per-scenario temp dirs removed in `afterAll`, no sleeps.
 */

import { createStyle, renderConsent } from "@stint/cli";
import type { ReceiptEntry } from "@stint/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PAYSTACK_HIDDEN_MARKERS, paystackVerifyFixture } from "../src/mocks/services.js";
import { FIXTURE_API_KEY, runPaymentConfirmationScenario } from "../src/payment-confirm.js";
import type { PaymentConfirmResult, PaymentConfirmScenarioOptions } from "../src/payment-confirm.js";
import { PAYMENT_TOOL } from "../src/profile.js";

const PAYSTACK = "paystack.transactions";
const REFERENCE = "ref_1001";
const LICENSE_MARKER = "v4.public.";
const EXIT_WRONG_STATE = 9;

const disposers: Array<() => Promise<void>> = [];

async function scenario(options: PaymentConfirmScenarioOptions = {}): Promise<PaymentConfirmResult> {
  const result = await runPaymentConfirmationScenario(options);
  disposers.push(result.dispose);
  return result;
}

afterAll(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

/** The verified chain as short, comparable tokens. */
function chain(entries: readonly ReceiptEntry[]): string[] {
  return entries.flatMap((entry) => {
    const payload = entry.payload as { event?: string; outcome?: string; resource?: string; step?: string };
    if (entry.type === "transition") return [`transition:${payload.event ?? "?"}`];
    if (entry.type === "call") return [`call:${payload.resource ?? "?"}:${payload.outcome ?? "?"}`];
    if (entry.type === "teardown_step") return [`teardown:${payload.step ?? "?"}:${payload.outcome ?? "?"}`];
    return [];
  });
}

/** Every surface an agent, a receipt reader or a terminal could see must be free of every secret and hidden field. */
function expectNothingLeaks(surface: string, what: string): void {
  expect(surface, `${what} must not carry the license marker`).not.toContain(LICENSE_MARKER);
  expect(surface, `${what} must not carry the API key`).not.toContain(FIXTURE_API_KEY);
  for (const marker of PAYSTACK_HIDDEN_MARKERS) {
    expect(surface, `${what} must not carry a hidden Paystack field`).not.toContain(marker);
  }
}

function agentText(result: { content?: unknown } | undefined): string {
  const content = (result?.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("");
}

describe("payment confirmation: the confirmed flow (hermetic, no environment variable)", () => {
  let run: PaymentConfirmResult;

  beforeAll(async () => {
    run = await scenario();
  });

  it("creates the lease with the three parameters bound and consent showing the api_key kind", () => {
    expect(run.exitCodes.create).toBe(0);
    expect(run.consentRequests).toHaveLength(1);

    const request = run.consentRequests[0];
    if (request === undefined) throw new Error("no consent request was recorded");
    expect(request.custody?.credentials).toEqual([
      { resource: PAYSTACK, kind: "api_key", revocation: "unsupported" },
    ]);

    const screen = renderConsent(request.manifest.manifest, createStyle(false), request.custody, request.parameters);
    expect(screen).toContain(`${PAYSTACK} (api_key): cannot be revoked by Stint`);
    expect(screen).toContain("reference (string): ref_1001");
    expect(screen).toContain("expected_amount_kobo (integer): 30050");
    expect(screen).toContain("currency (currency): NGN");
    expectNothingLeaks(screen, "the consent screen");

    // The lease carries exactly what the scripted user typed (bound once, at activation).
    expect(run.leaseAfterCreate?.state).toBe("active");
    expect(run.leaseAfterCreate?.jobParameters).toEqual({
      reference: REFERENCE,
      expected_amount_kobo: 30_050,
      currency: "NGN",
    });
  });

  it("the agent's verify call returns rows carrying verdict plus the allowlist and nothing else", () => {
    expect(run.toolNames).toContain(PAYMENT_TOOL);
    const verify = run.results[0];
    expect(verify?.isError).not.toBe(true);

    const body = JSON.parse(agentText(verify)) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0] ?? {};
    expect(row["verdict"]).toBe("confirmed");
    expect(Object.keys(row).sort()).toEqual(
      [
        "amount",
        "channel",
        "created_at",
        "currency",
        "domain",
        "fees",
        "paid_at",
        "reference",
        "requested_amount",
        "status",
        "verdict",
      ].sort(),
    );
    for (const hidden of ["authorization", "customer", "ip_address", "id"]) {
      expect(row, `row must not carry ${hidden}`).not.toHaveProperty(hidden);
    }
  });

  it("the agent can only ask for a check: the signal reaches the user and the lease stays active", () => {
    const signal = run.results[1];
    expect(signal?.isError).not.toBe(true);
    expect(run.events.some((event) => event.type === "outcome_check_requested")).toBe(true);
    // Nothing the agent did completed the lease: the user's check is the first transition after activation.
    expect(run.leaseBeforeCheck?.state).toBe("active");
  });

  it("verify-outcome exits 0 and the lease goes completed then cleaned_up with the receipt trail", () => {
    expect(run.checks).toHaveLength(1);
    expect(run.checks[0]?.code).toBe(0);
    expect(run.lease?.state).toBe("cleaned_up");

    const tokens = chain(run.verifiedReceipts);
    const wanted = [
      `call:${PAYSTACK}:allowed`, // the agent's verify read
      `call:${PAYSTACK}:allowed`, // the user's check read
      "transition:outcome_verified",
      "transition:begin_teardown",
      `teardown:revoke_oauth:discarded_revocation_unsupported`,
    ];
    let at = 0;
    for (const token of tokens) if (token === wanted[at]) at += 1;
    expect(at, `chain ${JSON.stringify(tokens)} must contain ${JSON.stringify(wanted)} in order`).toBe(wanted.length);
    expect(tokens.filter((token) => token === "transition:outcome_verified")).toHaveLength(1);

    const last = run.timeline[run.timeline.length - 1];
    expect(last?.entry.type).toBe("transition");
    if (last?.entry.type === "transition") expect(last.entry.payload.to).toBe("cleaned_up");
  });

  it("shows the unrevoked label and exactly one rotate line for paystack.transactions", () => {
    const check = run.checks[0];
    expect(check?.out).toContain("cleaned_up (credential not revoked upstream)");
    const rotate = `The credential for ${PAYSTACK} was not revoked upstream. Rotate it in the provider dashboard.`;
    expect(check?.err.split(rotate).length).toBe(2);
  });

  it("sent the bearer key only to the mock origin, to the verify route, and never to the authorization server", () => {
    // The agent's read plus the user's check: two GETs, nothing else reached the mock.
    expect(run.paystackRequests.map((request) => request.method)).toEqual(["GET", "GET"]);
    for (const request of run.paystackRequests) {
      expect(request.url).toBe(`/transaction/verify/${REFERENCE}`);
      expect(request.authorization).toBe(`Bearer ${FIXTURE_API_KEY}`);
    }
    expect(run.as.tokenEndpointHits).toBe(0);
    expect(run.as.revokeHits).toBe(0);
  });

  it("leaks neither the key nor a hidden field into agent results, receipts, command output or the store", async () => {
    expectNothingLeaks(JSON.stringify(run.results), "agent results");
    expectNothingLeaks(JSON.stringify(run.toolNames), "tools/list");
    expectNothingLeaks(JSON.stringify([run.verifiedReceipts, run.attestedReceipts]), "receipts");
    expectNothingLeaks(run.cliOutput, "command output");
    // Teardown discarded the credential: nothing left on disk carries the key.
    expectNothingLeaks(await run.readStoreText(), "the store after teardown");
    // The scan has teeth: the key really did cross the wire to the mock.
    expect(run.paystackRequests.some((request) => request.authorization?.includes(FIXTURE_API_KEY))).toBe(true);
  });
});

describe("payment confirmation: a failed check is not terminal", () => {
  it("amount_mismatch exits 9 with the verdict line, leaves the lease active, and a corrected fixture then completes it", async () => {
    const run = await scenario({
      verify: { [REFERENCE]: paystackVerifyFixture({ requested_amount: 99_999 }) },
      checks: [
        {},
        {
          before: (context) => {
            context.paystack.setVerifyFixture(REFERENCE, paystackVerifyFixture());
          },
        },
      ],
    });

    expect(run.checks).toHaveLength(2);
    expect(run.checks[0]?.code).toBe(EXIT_WRONG_STATE);
    expect(run.checks[0]?.err).toContain("verdict: amount_mismatch");
    expect(run.checks[0]?.err).toContain(run.leaseId);
    expect(run.checks[0]?.stateAfter).toBe("active");
    // The differing value never reaches a terminal.
    expect(run.checks[0]?.out + (run.checks[0]?.err ?? "")).not.toContain("99999");

    expect(run.checks[1]?.code).toBe(0);
    expect(run.lease?.state).toBe("cleaned_up");
    // Two checks, one lease: one denied then one allowed verification receipt on the same chain.
    const tokens = chain(run.verifiedReceipts);
    expect(tokens.filter((token) => token === `call:${PAYSTACK}:denied`)).toHaveLength(1);
    expect(tokens.filter((token) => token === "transition:outcome_verified")).toHaveLength(1);
    expectNothingLeaks(run.cliOutput, "command output");
  });

  it("an unknown reference (404) is the not_found verdict, exit 9, lease active", async () => {
    const run = await scenario({ verify: {} });

    expect(run.checks[0]?.code).toBe(EXIT_WRONG_STATE);
    expect(run.checks[0]?.err).toContain("verdict: not_found");
    expect(run.checks[0]?.stateAfter).toBe("active");
    expect(run.lease?.state).toBe("active");
    expectNothingLeaks(run.cliOutput, "command output");
  });

  it.each([
    [429, "rate limited"],
    [500, "server error"],
  ] as const)("a transient %i (%s) is the generic failed line, a denied read-error receipt, lease active", async (status) => {
    const run = await scenario({
      checks: [
        {
          before: (context) => {
            context.paystack.failNextVerify(status);
          },
        },
      ],
    });

    expect(run.checks[0]?.code).toBe(EXIT_WRONG_STATE);
    expect(run.checks[0]?.err).toContain(`The outcome check for lease ${run.leaseId} did not pass; the lease stays active.`);
    expect(run.checks[0]?.err).not.toMatch(/verdict:/);
    expect(run.checks[0]?.err).not.toContain("Injected failure");
    expect(run.lease?.state).toBe("active");

    // The agent's own earlier read was allowed; the check's read was denied and nothing transitioned.
    expect(chain(run.verifiedReceipts)).toEqual([`call:${PAYSTACK}:allowed`, `call:${PAYSTACK}:denied`]);
    expect(JSON.stringify(run.verifiedReceipts)).toContain("verification_read_error");
    expectNothingLeaks(run.cliOutput, "command output");
  });
});

describe("payment confirmation: every documented non-success status is not_success", () => {
  const STATUSES = ["abandoned", "failed", "ongoing", "pending", "processing", "queued", "reversed"] as const;
  const CASES: ReadonlyArray<{ readonly name: string; readonly data: Record<string, unknown>; readonly envelope?: boolean }> = [
    ...STATUSES.map((status) => ({ name: status, data: { status } })),
    // R2 trap: the envelope flag says the CALL worked and a misleading gateway text says "Successful";
    // only data.status (failed) is the truth, and amount and currency both match.
    { name: "envelope trap (call ok, data.status failed)", data: { status: "failed", gateway_response: "Successful" } },
  ];

  let run: PaymentConfirmResult;

  beforeAll(async () => {
    // One lease, one check per case: each failure leaves the lease active for the next.
    run = await scenario({
      checks: CASES.map((entry) => ({
        before: (context) => {
          context.paystack.setVerifyFixture(REFERENCE, paystackVerifyFixture(entry.data, { envelopeStatus: true }));
        },
      })),
    });
  });

  it.each(CASES.map((entry, index) => [entry.name, index] as const))("%s -> not_success, exit 9", (_name, index) => {
    expect(run.checks[index]?.code).toBe(EXIT_WRONG_STATE);
    expect(run.checks[index]?.err).toContain("verdict: not_success");
    expect(run.checks[index]?.stateAfter).toBe("active");
  });

  it("never completed the lease and leaked nothing", () => {
    expect(run.lease?.state).toBe("active");
    expectNothingLeaks(run.cliOutput, "command output");
  });
});
