/**
 * The REAL Paystack test-mode e2e (PSTK-07): the same payment-confirmation
 * scenario as `e2e.payment-confirm.test.ts`, but against `https://api.paystack.co`
 * with a real test-mode secret key and a transaction this suite initializes and
 * pays itself.
 *
 * THE ENV-GATED CONVENTION (the first suite in the repo to use it; later suites
 * copy this shape):
 *
 *   const KEY = process.env.PAYSTACK_TEST_SECRET_KEY;       // read ONCE, at module scope
 *   describe.skipIf(KEY === undefined || KEY === "")(...)   // the gate wraps ONLY the real describe
 *
 * - The gate is the only place the variable is consulted. The hermetic suites
 *   never read it and always run; a keyless run passes with this describe reported
 *   as skipped and makes no network call (the describe body only declares tests,
 *   and its hooks do not run when it is skipped).
 * - The key lives in memory only: it is never committed, printed, logged or
 *   interpolated into a message. Failures here say the step and an integer HTTP
 *   status, never an upstream body.
 * - A key that is not a test-mode key (`sk_test_` prefix) is refused before any
 *   request, so a live key can never initialize a live transaction from here.
 * - The key is sent to exactly one origin, {@link PAYSTACK_ORIGIN}, which is also
 *   what the closed API-key provider table resolves `paystack` to. The scenario's
 *   credential entry names NO origin in this mode, so a table that failed to
 *   resolve it would fail `create`.
 *
 * Run it: PAYSTACK_TEST_SECRET_KEY=sk_test_... pnpm --filter
 * @stint/example-payment-reconciler exec vitest run test/e2e.paystack-test-mode.test.ts
 *
 * DOCUMENTED-BUT-UNVERIFIED (R7): the payment choreography below follows the
 * published docs and has not been run against the live service. Sources:
 *   https://paystack.com/docs/api/transaction/#initialize
 *   https://paystack.com/docs/api/charge/
 *   https://paystack.com/docs/payments/test-payments/  (success card 4084 0840 8408 4081,
 *     PIN 0000, OTP 123456)
 * The first run with a real key settles, and must record here: (1) whether
 * `/charge` accepts the initialized transaction's reference, (2) the exact
 * unknown-reference HTTP status (the second test pins `not_found`), (3) whether a
 * successful test transaction carries `requested_amount` (the verdict treats an
 * absent one as `unknown`, fail closed). Adjust the choreography, the mock or the
 * connector's status branch if they differ; never the verdict mapping.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runPaymentConfirmationScenario } from "../src/payment-confirm.js";
import type { PaymentConfirmResult } from "../src/payment-confirm.js";

/** The only origin the key may reach; equals the closed provider table's value for `paystack`. */
const PAYSTACK_ORIGIN = "https://api.paystack.co";

/** Read once at module scope; never printed. */
const PAYSTACK_KEY = process.env.PAYSTACK_TEST_SECRET_KEY;

const AMOUNT_KOBO = 50_000;
const CURRENCY = "NGN";
const BUYER_EMAIL = "stint-e2e-buyer@example.test";
const SETUP_TIMEOUT_MS = 120_000;
const MAX_CHARGE_STEPS = 6;

/** Public Paystack test instrument (R6), not a secret. */
const TEST_CARD = { number: "4084084084084081", cvv: "408" } as const;
const TEST_PIN = "0000";
const TEST_OTP = "123456";

interface Envelope {
  readonly status?: unknown;
  readonly data?: { readonly status?: unknown; readonly reference?: unknown } | undefined;
}

/** POSTs JSON to Paystack with the key. The only function that puts the key on the wire; the origin is a constant. */
async function paystackPost(key: string, route: string, body: Record<string, unknown>): Promise<Envelope> {
  const response = await fetch(`${PAYSTACK_ORIGIN}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Paystack test-mode setup failed at ${route} (HTTP ${String(response.status)}).`);
  }
  return (await response.json()) as Envelope;
}

/** Initializes a test transaction for the scenario amount and returns its reference. */
async function initializeTransaction(key: string): Promise<string> {
  const reference = `stint_e2e_${randomUUID().replaceAll("-", "")}`;
  const initialized = await paystackPost(key, "/transaction/initialize", {
    email: BUYER_EMAIL,
    amount: AMOUNT_KOBO,
    currency: CURRENCY,
    reference,
  });
  if (initialized.status !== true || initialized.data?.reference !== reference) {
    throw new Error("Paystack test-mode setup failed: the transaction was not initialized.");
  }
  return reference;
}

/**
 * Pays the transaction with the R6 success test card through the charge flow,
 * answering the PIN and OTP prompts the test card documents. Any other prompt, or
 * a status that is not progressing, fails with a fixed message.
 */
async function payWithTestCard(key: string, reference: string): Promise<void> {
  const expiryYear = String(new Date().getUTCFullYear() + 3);
  let step = await paystackPost(key, "/charge", {
    email: BUYER_EMAIL,
    amount: AMOUNT_KOBO,
    reference,
    card: { ...TEST_CARD, expiry_month: "12", expiry_year: expiryYear },
  });
  for (let attempt = 0; attempt < MAX_CHARGE_STEPS; attempt += 1) {
    const status = step.data?.status;
    if (status === "success") return;
    if (status === "send_pin") {
      step = await paystackPost(key, "/charge/submit_pin", { pin: TEST_PIN, reference });
    } else if (status === "send_otp") {
      step = await paystackPost(key, "/charge/submit_otp", { otp: TEST_OTP, reference });
    } else {
      throw new Error("Paystack test-mode setup failed: the test charge did not reach success.");
    }
  }
  throw new Error("Paystack test-mode setup failed: the test charge did not settle.");
}

function agentText(result: { content?: unknown } | undefined): string {
  const content = (result?.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("");
}

const disposers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe.skipIf(PAYSTACK_KEY === undefined || PAYSTACK_KEY === "")(
  "Paystack test mode: the payment-confirmation scenario against api.paystack.co",
  () => {
    const key = PAYSTACK_KEY ?? "";
    let reference = "";
    let confirmed: PaymentConfirmResult;

    beforeAll(async () => {
      if (!key.startsWith("sk_test_")) {
        throw new Error("PAYSTACK_TEST_SECRET_KEY must be a test-mode secret key.");
      }
      reference = await initializeTransaction(key);
      await payWithTestCard(key, reference);
      // The reference is bound at consent (the scripted user types it); the key arrives through the
      // credentials file with no origin, so the closed provider table decides where it may go.
      confirmed = await runPaymentConfirmationScenario({
        real: { apiKey: key, reference, expectedAmountKobo: AMOUNT_KOBO, currency: CURRENCY },
      });
      disposers.push(confirmed.dispose);
    }, SETUP_TIMEOUT_MS);

    it("binds the initialized reference and reaches a confirmed verdict, then a completed and cleaned-up lease", () => {
      expect(confirmed.exitCodes.create).toBe(0);
      expect(confirmed.leaseAfterCreate?.jobParameters).toEqual({
        reference,
        expected_amount_kobo: AMOUNT_KOBO,
        currency: CURRENCY,
      });

      const body = JSON.parse(agentText(confirmed.results[0])) as { rows: Array<Record<string, unknown>> };
      expect(body.rows[0]?.["verdict"]).toBe("confirmed");
      // `domain` is "test" or "live" (R3): it proves this really ran in test mode.
      expect(body.rows[0]?.["domain"]).toBe("test");

      expect(confirmed.checks[0]?.code).toBe(0);
      expect(confirmed.lease?.state).toBe("cleaned_up");
      expect(confirmed.checks[0]?.out).toContain("cleaned_up (credential not revoked upstream)");
      expect(confirmed.checks[0]?.err).toContain(
        "The credential for paystack.transactions was not revoked upstream. Rotate it in the provider dashboard.",
      );
    });

    it("never shows the key or the buyer's e-mail to the agent, a receipt or the terminal", () => {
      const surfaces = [
        JSON.stringify(confirmed.results),
        JSON.stringify([confirmed.verifiedReceipts, confirmed.attestedReceipts]),
        confirmed.cliOutput,
      ].join("\n");
      expect(surfaces).not.toContain(key);
      expect(surfaces).not.toContain(BUYER_EMAIL);
      expect(confirmed.as.tokenEndpointHits).toBe(0);
    });

    // R7 probe: the documented-but-unverified shape of an unknown reference (assumed HTTP 404).
    it("an unknown reference is the not_found verdict and leaves the lease active", async () => {
      const unknown = await runPaymentConfirmationScenario({
        real: {
          apiKey: key,
          reference: `stint_e2e_unknown_${randomUUID().replaceAll("-", "")}`,
          expectedAmountKobo: AMOUNT_KOBO,
          currency: CURRENCY,
        },
      });
      disposers.push(unknown.dispose);

      expect(unknown.checks[0]?.code).toBe(9);
      expect(unknown.checks[0]?.err).toContain("verdict: not_found");
      expect(unknown.lease?.state).toBe("active");
    });
  },
);
