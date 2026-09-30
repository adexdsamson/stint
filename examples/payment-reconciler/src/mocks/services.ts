/**
 * The mocked customer services (D-06): a Paystack transactions API and an
 * orders sheet, each a plain `node:http` server on `127.0.0.1:0` reached through
 * the real REST connector (`createRestOutboundConnector` POSTs the binding's
 * endpoint with a proxy-injected `Authorization: Bearer` and a JSON body for
 * EVERY tool, read or write alike).
 *
 * Because every call is a POST to one URL per resource, the orders sheet tells a
 * read from a write by body shape (Pattern 2): `{ order_id, status }` updates a
 * row, anything else lists rows -- including the `resource_query` verifier's
 * synthetic read, which POSTs `{}`.
 *
 * Every request is recorded (`method`, `url`, every header, raw `body`) so a
 * test can prove the OAuth access token arrives and the license NEVER does
 * (LIC-05, T-07-LIC): {@link assertNoLicenseLeak} fails on any `v4.public.`
 * substring in a recorded request. Always `stop()` the servers.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request a mock service received. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** The `Authorization` header, verbatim (the proxy-injected bearer for a healthy call). */
  readonly authorization: string | undefined;
  /** Every request header value joined by a newline, for leak scanning. */
  readonly headerText: string;
  /** The raw request body text. */
  readonly body: string;
  /** The parsed JSON body (`undefined` when it was not valid JSON). */
  readonly json: unknown;
  /** The sheets mock's classification; `"call"` for the paystack mock. */
  readonly kind: "read" | "write" | "call";
}

/** What every loopback service exposes. */
export interface ServiceMock {
  /** The endpoint a profile's `endpoints` map points at. */
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  readonly hits: number;
  stop(): Promise<void>;
}

/** A sheet row. */
export interface OrderRow {
  order_id: string;
  status: string;
}

/** The orders sheet: per-kind counters plus the live in-memory rows. */
export interface OrdersSheetMock extends ServiceMock {
  readonly rows: readonly OrderRow[];
  readonly readHits: number;
  readonly writeHits: number;
}

/** The settled transactions the Paystack mock returns. */
export const PAYSTACK_TRANSACTIONS = [
  { id: "t_1001", reference: "ref_1001", amount: 250_000, currency: "NGN", status: "success", order_id: "ord_1001" },
] as const;

function initialRows(): OrderRow[] {
  return [
    { order_id: "ord_1001", status: "open" },
    { order_id: "ord_1002", status: "open" },
  ];
}

async function readText(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) text += (chunk as Buffer).toString("utf8");
  return text;
}

function parseJson(text: string): unknown {
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isWrite(json: unknown): json is { order_id: string; status: string } {
  if (typeof json !== "object" || json === null) return false;
  const { order_id: orderId, status } = json as Record<string, unknown>;
  return typeof orderId === "string" && typeof status === "string";
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

async function startRecordingServer(
  classify: (json: unknown) => RecordedRequest["kind"],
  respond: (json: unknown, kind: RecordedRequest["kind"]) => Reply,
): Promise<{ url: string; requests: RecordedRequest[]; stop: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void readText(req)
      .then((body) => {
        const json = parseJson(body);
        const kind = classify(json);
        const headerText = Object.values(req.headers)
          .map((value) => (Array.isArray(value) ? value.join(",") : (value ?? "")))
          .join("\n");
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization,
          headerText,
          body,
          json,
          kind,
        });
        const reply = respond(json, kind);
        res.statusCode = reply.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply.body));
      })
      .catch(() => {
        res.statusCode = 500;
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Starts the Paystack transactions mock: every POST returns the settled transactions list. */
export async function startPaystackMock(): Promise<ServiceMock> {
  const server = await startRecordingServer(
    () => "call",
    () => ({ status: 200, body: { transactions: PAYSTACK_TRANSACTIONS } }),
  );
  return {
    url: server.url,
    requests: server.requests,
    get hits() {
      return server.requests.length;
    },
    stop: server.stop,
  };
}

/** Starts the orders-sheet mock (read `{}` -> rows; write `{ order_id, status }` -> update a row). */
export async function startOrdersSheetMock(): Promise<OrdersSheetMock> {
  const rows = initialRows();
  const server = await startRecordingServer(
    (json) => (isWrite(json) ? "write" : "read"),
    (json, kind) => {
      if (kind === "write" && isWrite(json)) {
        const row = rows.find((candidate) => candidate.order_id === json.order_id);
        if (row === undefined) return { status: 404, body: { ok: false } };
        row.status = json.status;
        return { status: 200, body: { ok: true, row: { ...row } } };
      }
      return { status: 200, body: { rows: rows.map((row) => ({ ...row })) } };
    },
  );
  return {
    url: server.url,
    requests: server.requests,
    rows,
    get hits() {
      return server.requests.length;
    },
    get readHits() {
      return server.requests.filter((r) => r.kind === "read").length;
    },
    get writeHits() {
      return server.requests.filter((r) => r.kind === "write").length;
    },
    stop: server.stop,
  };
}

/** Starts both services. */
export async function startServices(): Promise<{
  readonly paystack: ServiceMock;
  readonly sheets: OrdersSheetMock;
  stop(): Promise<void>;
}> {
  const paystack = await startPaystackMock();
  const sheets = await startOrdersSheetMock();
  return {
    paystack,
    sheets,
    stop: async () => {
      await Promise.all([paystack.stop(), sheets.stop()]);
    },
  };
}

const LICENSE_MARKER = "v4.public.";

/**
 * LIC-05: the customer services must only ever see the OAuth Bearer access
 * token, never the license. Throws if any recorded request's URL, headers or
 * body contains a `v4.public.` PASETO marker. Each recorder is one or more
 * {@link ServiceMock}s or bare request arrays.
 */
export function assertNoLicenseLeak(
  ...recorders: ReadonlyArray<ServiceMock | readonly RecordedRequest[]>
): void {
  for (const recorder of recorders) {
    const requests = "requests" in recorder ? recorder.requests : recorder;
    for (const request of requests) {
      const haystack = `${request.url}\n${request.headerText}\n${request.body}`;
      if (haystack.includes(LICENSE_MARKER)) {
        throw new Error("LIC-05 violated: a license reached a customer service request.");
      }
    }
  }
}
