/**
 * A small, runtime-owned HTTPS client that POSTs a cleanup token to a
 * publisher's `cleanup.hook.url` (D-12) -- deliberately NOT the
 * `OutboundConnector` (`../connectors/outbound-connector.ts`), which is
 * credential/binding-shaped for customer resources (D-01, D-02): the
 * cleanup hook is a publisher-owned endpoint, not a customer resource, and
 * carries a cleanup token, never an OAuth access token.
 *
 * A 2xx response maps to `{ ok: true }` -- an ATTESTED publisher claim
 * (Section 13), never upgraded to "verified" by this function or its caller
 * (D-12, Pitfall 5 discipline). Every other outcome -- a non-2xx status, a
 * thrown/rejected fetch (network failure, DNS failure, connection refused),
 * or a client-side timeout -- collapses to the identical `{ ok: false }`.
 * No raw HTTP status text or fetch/network error EVER escapes this function
 * (Pitfall 8 scrub discipline): a caller building a receipt from this result
 * can only ever see the closed boolean, never a message that could leak
 * infrastructure detail into a receipt or the agent.
 */

/** The subset of the global `fetch` signature this client needs -- injectable so tests never perform an unintended real network call. */
export type CleanupFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PostCleanupTokenOptions {
  readonly fetchImpl?: CleanupFetchLike;
  /** Client-side request timeout in milliseconds -- bounds a hung/slow hook so a single unresponsive publisher endpoint never blocks teardown indefinitely. */
  readonly timeoutMs?: number;
}

/** A conservative default: publisher cleanup hooks are expected to respond quickly; this is not a runtime-config value like {@link CLEANUP_TOKEN_TTL_SECONDS} (D-11), just a client-side network guard. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * POSTs `token` as a bearer-authenticated request to `url` (the publisher's
 * cleanup hook). Never throws: any exception (abort/timeout, network
 * failure, malformed URL) is caught and collapsed to `{ ok: false }`,
 * exactly like a non-2xx response.
 *
 * The client-side deadline uses the standard `AbortSignal.timeout()` Web API
 * rather than a hand-rolled `setTimeout`/`AbortController` pair -- this is a
 * single request's bounded deadline, NOT a retry/backoff mechanism (D-15
 * forbids the latter anywhere under `teardown/`, never the former).
 */
export async function postCleanupToken(
  url: string,
  token: string,
  opts: PostCleanupTokenOptions = {},
): Promise<{ readonly ok: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}
