/**
 * The example's RUN PROFILE (runtime-owned, never agent-supplied): the tool
 * catalog the agent sees, the bindings that classify each tool, the OAuth
 * client identity, and the resource-identifier -> loopback-URL `endpoints` map
 * (the REST connector uses `binding.resource` as its request target, so an
 * identifier like `paystack.transactions` is not a URL on its own).
 *
 * The profile carries NO secret (secrets live only in the credentials file /
 * in-memory vault). `buildRunProfile` returns the in-code profile the
 * in-process harness passes to `runLease` (its `sheets.orders` read binding
 * carries the `resource_query` verifier's `rowAdapter`); `writeJsonProfile`
 * writes the JSON twin for a spawned `stint run --profile` (a function is not
 * JSON, so the rowAdapter is dropped there).
 *
 * `issue_refund` is deliberately NOT in the catalog: the `pay` access class is
 * not granted, so the ungranted call denies `no_binding` (Pitfall 12).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectorBinding, ConnectorRowAdapter } from "@stint/core";
import { createBindingSet } from "@stint/core";
import type { RunProfile } from "@stint/cli";
import { createToolCatalog, verdictRowAdapter } from "@stint/proxy";
import type { OAuthClient, ToolCatalogEntry } from "@stint/proxy";
import * as oauth from "oauth4webapi";

/** The two resource identifiers the manifest scopes grant. */
export const PAYSTACK_RESOURCE = "paystack.transactions";
export const SHEETS_RESOURCE = "sheets.orders";

/** The structural slice of a mock-AS harness the profile's OAuth block is built from. */
export interface ProfileMockAs {
  readonly issuerUrl: string;
  readonly oauthClient: {
    readonly as: { readonly token_endpoint?: string; readonly revocation_endpoint?: string };
    readonly client: { readonly client_id: string };
  };
}

/** Inputs for {@link buildRunProfile}. */
export interface BuildRunProfileOptions {
  readonly mockAs: ProfileMockAs;
  /** The Paystack mock's endpoint (what `paystack.transactions` resolves to). */
  readonly paystackUrl: string;
  /** The orders-sheet mock's endpoint (what `sheets.orders` resolves to). */
  readonly sheetsUrl: string;
}

const CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: "list_transactions",
    description: "Lists settled Paystack transactions.",
    inputSchema: { type: "object" },
  },
  {
    name: "read_orders",
    description: "Reads the rows of the orders sheet.",
    inputSchema: { type: "object" },
  },
  {
    name: "mark_order_reconciled",
    description: "Marks an order reconciled on the orders sheet (irreversible, needs approval).",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, status: { type: "string" } },
      required: ["order_id", "status"],
    },
  },
];

/**
 * Normalizes the orders sheet's read response to the `{ rows }` shape the
 * `resource_query` predicate (`count(rows where status = 'reconciled') >= 1`)
 * evaluates over. Anything unexpected yields no rows, so a malformed response
 * can never make the verifier pass.
 */
export const ordersRowAdapter: ConnectorRowAdapter = (result) => {
  const body = result.body;
  if (typeof body !== "object" || body === null || !("rows" in body) || !Array.isArray(body.rows)) {
    return { rows: [] };
  }
  const rows: Array<{ order_id: unknown; status: unknown }> = [];
  for (const row of body.rows as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { order_id: orderId, status } = row as Record<string, unknown>;
    rows.push({ order_id: orderId, status });
  }
  return { rows };
};

function binding(
  tool: string,
  resource: string,
  access: ConnectorBinding["access"],
  extra: Partial<ConnectorBinding> = {},
): ConnectorBinding {
  return { tool, resource, access, irreversible: false, provenance: "built_in", ...extra };
}

/** The OAuth block both profiles carry: the same AS object a JSON profile builds. */
function oauthClientOf(mockAs: ProfileMockAs): OAuthClient {
  return {
    as: {
      issuer: mockAs.issuerUrl,
      token_endpoint: mockAs.oauthClient.as.token_endpoint ?? `${mockAs.issuerUrl}/token`,
      ...(mockAs.oauthClient.as.revocation_endpoint === undefined
        ? {}
        : { revocation_endpoint: mockAs.oauthClient.as.revocation_endpoint }),
    },
    client: { client_id: mockAs.oauthClient.client.client_id },
    clientAuth: oauth.None(),
  };
}

/** Builds the in-code run profile for the example against a mock authorization server. */
export function buildRunProfile(options: BuildRunProfileOptions): RunProfile {
  const { mockAs, paystackUrl, sheetsUrl } = options;
  const oauthClient = oauthClientOf(mockAs);

  return {
    catalog: createToolCatalog(CATALOG),
    bindings: createBindingSet([
      binding("list_transactions", PAYSTACK_RESOURCE, "read"),
      binding("read_orders", SHEETS_RESOURCE, "read", { rowAdapter: ordersRowAdapter }),
      binding("mark_order_reconciled", SHEETS_RESOURCE, "write", { irreversible: true }),
    ]),
    oauth: oauthClient,
    endpoints: { [PAYSTACK_RESOURCE]: paystackUrl, [SHEETS_RESOURCE]: sheetsUrl },
  };
}

/** The one tool the payment-confirmation agent sees. It takes no arguments: the lease binds the transaction (PSTK-04). */
export const PAYMENT_TOOL = "verify_payment";

/** Inputs for {@link buildPaymentRunProfile}. */
export interface BuildPaymentRunProfileOptions {
  readonly mockAs: ProfileMockAs;
}

/**
 * The payment-confirmation run profile (Phase 10): one read tool over
 * `paystack.transactions` whose binding carries the built-in `verdictRowAdapter`,
 * so both the agent's call and the verifier read yield verdict rows. No
 * `endpoints` entry: an API key is sent only to its own recorded origin, never to
 * a profile-supplied URL. The OAuth block is required by the profile shape and is
 * never used (the credential is an API key).
 */
export function buildPaymentRunProfile(options: BuildPaymentRunProfileOptions): RunProfile {
  return {
    catalog: createToolCatalog([
      {
        name: PAYMENT_TOOL,
        description: "Checks the payment this lease was created for. Takes no arguments.",
        inputSchema: { type: "object" },
      },
    ]),
    bindings: createBindingSet([
      binding(PAYMENT_TOOL, PAYSTACK_RESOURCE, "read", { rowAdapter: verdictRowAdapter }),
    ]),
    oauth: oauthClientOf(options.mockAs),
  };
}

/**
 * Writes the profile as the JSON a spawned `stint run --profile <file>` reads.
 * A `rowAdapter` function is dropped (it is not JSON), except the built-in
 * `verdictRowAdapter`, which is written by name (`"rowAdapter": "verdict"`) for the
 * CLI to map back; nothing secret is in the profile. Returns the file path.
 */
export async function writeJsonProfile(profile: RunProfile, file: string): Promise<string> {
  const json = {
    catalog: Object.values(profile.catalog),
    bindings: Object.values(profile.bindings).map((b) => ({
      tool: b.tool,
      resource: b.resource,
      access: b.access,
      irreversible: b.irreversible,
      provenance: b.provenance,
      ...(b.rowAdapter === verdictRowAdapter ? { rowAdapter: "verdict" } : {}),
    })),
    oauth: {
      as: {
        issuer: profile.oauth.as.issuer,
        ...(profile.oauth.as.token_endpoint === undefined
          ? {}
          : { token_endpoint: profile.oauth.as.token_endpoint }),
        ...(profile.oauth.as.revocation_endpoint === undefined
          ? {}
          : { revocation_endpoint: profile.oauth.as.revocation_endpoint }),
      },
      client_id: profile.oauth.client.client_id,
      auth_method: "none",
    },
    ...(profile.endpoints === undefined ? {} : { endpoints: profile.endpoints }),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(json, null, 2));
  return file;
}
