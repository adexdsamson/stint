/**
 * The Paystack transaction-verify surface (Phase 10, PSTK-01 to PSTK-05, D-C).
 *
 * This module holds the pure, zero-I/O half: the verdict, the allowlist and the
 * expectation parser. The verdict is COMPUTED IN CODE from a documented
 * envelope, so the ALP 7.6 predicate stays `exists(rows where verdict =
 * 'confirmed') >= 1` and the grammar never changes. The facts it encodes
 * (research R1 to R5):
 *
 * - R2: the envelope's top-level `status` is the API-call flag, NOT the
 *   transaction status. Only `data.status` decides; the envelope flag is read
 *   solely to require it.
 * - R3: the documented `data.status` values are a closed list; anything outside
 *   it is `unknown` (fail closed).
 * - R4: `data.amount` includes fees; `data.requested_amount` is what the
 *   transaction was initialised for. The comparison is `requested_amount`,
 *   always, and only a safe integer ever matches.
 * - R5: the agent sees `verdict` plus an allowlisted field set and nothing
 *   else. A strip-list would leak a field Paystack adds tomorrow; an allowlist
 *   fails closed.
 *
 * HTTP 404 (an unknown reference) is mapped to `not_found` by the CONNECTOR
 * ({@link createPaystackVerifyConnector}), not by the pure function: that is
 * body-only and a `not_found` verdict never comes out of it.
 *
 * The connector half follows the closed route in `API_KEY_RESOURCE_ROUTES`.
 * Its URL is the credential's recorded origin plus the route path, built only
 * from the lease-bound expectation: the agent's arguments and the binding's
 * resource name never reach the URL (PSTK-04, T-10-15, T-10-16).
 */

import type { ConnectorBinding } from "@stint/core";

import { isSecureOrLoopbackOrigin } from "../vault/oauth-client.js";
import { API_KEY_RESOURCE_ROUTES, OutboundOriginError } from "./outbound-connector.js";
import type { FetchLike, OutboundConnector, OutboundCredential } from "./outbound-connector.js";

/** The closed verdict list (PSTK-02). 10-06 interpolates a member into a fixed line. */
export type TransactionVerdict =
  | "confirmed"
  | "amount_mismatch"
  | "currency_mismatch"
  | "not_found"
  | "not_success"
  | "unknown";

/** Every member of {@link TransactionVerdict}, for defensive narrowing (row adapter, tests). */
export const TRANSACTION_VERDICTS: ReadonlySet<string> = new Set<TransactionVerdict>([
  "confirmed",
  "amount_mismatch",
  "currency_mismatch",
  "not_found",
  "not_success",
  "unknown",
]);

/** What the lease says the transaction must be: all three come from the lease-bound job parameters, never from the agent (PSTK-04). */
export interface TransactionExpectation {
  readonly reference: string;
  readonly expectedAmountKobo: number;
  readonly currency: string;
}

/** R3: the documented transaction statuses. Anything else maps to `unknown`. */
export const PAYSTACK_TRANSACTION_STATUSES: ReadonlySet<string> = new Set([
  "abandoned",
  "failed",
  "ongoing",
  "pending",
  "processing",
  "queued",
  "reversed",
  "success",
]);

/** R5: the ONLY transaction fields an agent can ever see. No authorization.*, customer.*, ip_address or id. */
export const ALLOWLISTED_TRANSACTION_FIELDS: readonly string[] = Object.freeze([
  "status",
  "amount",
  "requested_amount",
  "currency",
  "reference",
  "paid_at",
  "created_at",
  "channel",
  "domain",
  "fees",
]);

/** A reference is path material, so it is held to a strict charset before it can be near a URL (T-10-16). */
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** True when `value` is a string that is safe to place in the verify path (after encoding). */
export function isValidTransactionReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_PATTERN.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Computes the verdict from a Paystack verify response BODY (R2/R3/R4). Pure.
 *
 * - envelope not a record, or `status !== true`, or `data` not a record -> `unknown`
 * - `data.status` not a string in the R3 list -> `unknown`
 * - `data.reference` present as a string and differing from the expectation -> `unknown`
 * - any listed status other than `success` -> `not_success`
 * - `success` with `requested_amount` not a safe integer, or `currency` not a string -> `unknown`
 * - `success` with `requested_amount` differing -> `amount_mismatch` (checked first)
 * - `success` with `currency` differing -> `currency_mismatch`
 * - otherwise `confirmed`
 *
 * `data.amount` (fees included) is never read.
 */
export function computeTransactionVerdict(body: unknown, expected: TransactionExpectation): TransactionVerdict {
  if (!isRecord(body) || body["status"] !== true) return "unknown";
  const data = body["data"];
  if (!isRecord(data)) return "unknown";

  const status = data["status"];
  if (typeof status !== "string" || !PAYSTACK_TRANSACTION_STATUSES.has(status)) return "unknown";

  const reference = data["reference"];
  if (typeof reference === "string" && reference !== expected.reference) return "unknown";

  if (status !== "success") return "not_success";

  const requested = data["requested_amount"];
  const currency = data["currency"];
  if (typeof requested !== "number" || !Number.isSafeInteger(requested)) return "unknown";
  if (typeof currency !== "string") return "unknown";

  if (requested !== expected.expectedAmountKobo) return "amount_mismatch";
  if (currency !== expected.currency) return "currency_mismatch";
  return "confirmed";
}

/**
 * Projects a Paystack `data` object to exactly the R5 allowlist (PSTK-03). Pure.
 * Only own, primitive values under an allowlisted key survive: a nested object
 * or array under an allowlisted name is dropped so structure cannot ride
 * through. Anything that is not a record yields `{}`.
 */
export function allowlistTransactionData(data: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(data)) return {};
  const projected: Record<string, unknown> = {};
  for (const field of ALLOWLISTED_TRANSACTION_FIELDS) {
    if (!Object.hasOwn(data, field)) continue;
    const value = data[field];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      projected[field] = value;
    }
  }
  return projected;
}

/**
 * Reads the expectation from the lease-bound job parameters (10-01 names:
 * `reference`, `expected_amount_kobo`, `currency`). Pure. Returns `undefined`
 * for anything that is not a well-formed triple, so a lease with no usable
 * expectation makes the connector refuse the call. Only the three closed names
 * are read; extra names are ignored.
 */
export function transactionExpectationFromParameters(parameters: unknown): TransactionExpectation | undefined {
  if (!isRecord(parameters)) return undefined;
  const reference = parameters["reference"];
  const amount = parameters["expected_amount_kobo"];
  const currency = parameters["currency"];
  if (!isValidTransactionReference(reference)) return undefined;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1) return undefined;
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) return undefined;
  return { reference, expectedAmountKobo: amount, currency };
}

/** The verify read is the same class of call as a token refresh, so it mirrors `DEFAULT_OAUTH_TIMEOUT_MS`. */
export const PAYSTACK_VERIFY_TIMEOUT_MS = 15_000;

/**
 * Thrown when the upstream could not give a trustworthy answer: a 429, a 5xx,
 * any other non-success non-404 status, a network error, a timeout, a refused
 * redirect, or an unparseable body (PSTK-05). Callers DENY the call and never
 * end, fail or transition the lease on it. The message is fixed text: it names
 * no URL, host, reference, status text or key.
 */
export class TransientUpstreamError extends Error {
  constructor() {
    super("@stint/proxy: the payment provider could not be read right now; try again later.");
    this.name = "TransientUpstreamError";
  }
}

/**
 * Thrown BEFORE any request when the verify route cannot be called safely: the
 * lease carries no usable expectation (or its reference fails the charset), or
 * the credential is not an API key. Fixed text, so neither the reference nor
 * the key can ride up toward the agent. Callers deny, never end leases.
 */
export class PaystackVerifyUsageError extends Error {
  constructor() {
    super("@stint/proxy: the payment verification is not configured for this lease.");
    this.name = "PaystackVerifyUsageError";
  }
}

/** What `createPaystackVerifyConnector` needs beyond its fetch. */
export interface PaystackVerifyOptions {
  /** Reads the lease-bound expectation at call time; `undefined` refuses the call (fail closed). */
  readonly expectation: () => TransactionExpectation | undefined;
  /** Test seam only: overrides {@link PAYSTACK_VERIFY_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The closed-route Paystack verify connector (PSTK-01, PSTK-04, PSTK-05). One
 * GET `{credential.origin}/transaction/verify/{reference}` with a bearer key,
 * `redirect: "error"` and a 15 s timeout. It returns `{ status, body: { rows:
 * [{ verdict, ...allowlisted }] } }` and never the raw upstream body.
 *
 * @param fetchImpl the injected fetch (a double in tests; never reached with a bad reference)
 * @param options the lease-bound expectation provider
 */
export function createPaystackVerifyConnector(
  fetchImpl: FetchLike,
  options: PaystackVerifyOptions,
): OutboundConnector {
  return {
    async execute(
      _binding: ConnectorBinding,
      _resolvedArgs: Readonly<Record<string, unknown>>,
      credential: OutboundCredential,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      // The agent's arguments and the binding are deliberately unread: the request is a function of
      // the lease-bound expectation and the credential's recorded origin alone (T-10-15).
      if (credential.kind !== "api_key") throw new PaystackVerifyUsageError();
      const expected = options.expectation();
      if (expected === undefined || !isValidTransactionReference(expected.reference)) {
        throw new PaystackVerifyUsageError();
      }
      const origin = credential.origin;
      if (origin === undefined || !isSecureOrLoopbackOrigin(origin)) throw new OutboundOriginError();

      const route = API_KEY_RESOURCE_ROUTES["paystack.transactions"];
      if (route === undefined) throw new PaystackVerifyUsageError();
      const url = `${new URL(origin).origin}${route.path.replace(":reference", encodeURIComponent(expected.reference))}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: route.method,
          headers: { authorization: `Bearer ${credential.accessToken}`, accept: "application/json" },
          // A redirect is an upstream attempt to move the key: an error, never a hop (CRED-02).
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? PAYSTACK_VERIFY_TIMEOUT_MS),
        });
      } catch {
        // Network error, refused redirect or timeout: the cause text is dropped on purpose.
        throw new TransientUpstreamError();
      }

      if (response.status === 404) {
        return { status: 404, body: { rows: [{ verdict: "not_found" satisfies TransactionVerdict }] } };
      }
      // Deliberately broader than 429/5xx: a surprising 3xx or 4xx can never mint a verdict.
      if (response.status < 200 || response.status > 299) throw new TransientUpstreamError();

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        // An unparseable body is not a verdict.
        throw new TransientUpstreamError();
      }

      const verdict = computeTransactionVerdict(parsed, expected);
      const data = isRecord(parsed) ? parsed["data"] : undefined;
      return { status: response.status, body: { rows: [{ verdict, ...allowlistTransactionData(data) }] } };
    },
  };
}
