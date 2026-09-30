/**
 * The non-secret run profile (Open Q2, A5). `catalog`, `bindings` and the OAuth
 * client identity are RUNTIME-OWNED inputs (Phase 4 D-08/D-12): they never come
 * from the manifest and never from the agent. Secrets are NOT in this file; the
 * only secret input on the run path is `--credentials` (D-02).
 *
 * Shape:
 * ```json
 * {
 *   "catalog":  [{ "name", "description", "inputSchema": {"type":"object",...}, "payAmount"? }],
 *   "bindings": [{ "tool", "resource", "access", "irreversible", "provenance" }],
 *   "oauth":    { "as": { "issuer", "token_endpoint", "revocation_endpoint"? },
 *                 "client_id", "auth_method": "none" },
 *   "endpoints": { "<resource identifier>": "<https or loopback http URL>" }   // optional
 * }
 * ```
 * `bindings` carry no `rowAdapter` (a function is not JSON). Confidential-client
 * auth methods need a secret and are therefore not expressible in a profile.
 */

import { readFile } from "node:fs/promises";

import { createBindingSet } from "@stint/core";
import type { BindingSet, ConnectorBinding } from "@stint/core";
import { createToolCatalog } from "@stint/proxy";
import type { OAuthClient, ToolCatalog, ToolCatalogEntry } from "@stint/proxy";
import type { Access } from "@stint/spec";

import { CliError, EXIT_CODES } from "../exit.js";
import { isLoopbackHttp } from "./loopback.js";

export interface RunProfile {
  readonly catalog: ToolCatalog;
  readonly bindings: BindingSet;
  readonly oauth: OAuthClient;
  /**
   * OPTIONAL map from a binding's resource IDENTIFIER (e.g. `paystack.transactions`) to the
   * `https:`/loopback-`http:` URL the REST connector must actually call. The connector uses
   * `binding.resource` as the request target, so without this an identifier is not a URL.
   * Runtime-owned configuration: never from the manifest, never from the agent.
   */
  readonly endpoints?: Readonly<Record<string, string>>;
}

const ACCESS: readonly string[] = ["read", "write", "send", "pay"];
const PROVENANCE: readonly string[] = ["built_in", "user_approved_custom"];

function bad(): CliError {
  return new CliError(EXIT_CODES.usage, "The run profile has an unexpected shape.");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  if (typeof v !== "string" || v === "") throw bad();
  return v;
}

function optUrl(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = str(v);
  if (!URL.canParse(s)) throw bad();
  return s;
}

function parseCatalogEntry(raw: unknown): ToolCatalogEntry {
  if (!isRecord(raw)) throw bad();
  const schema = raw.inputSchema;
  if (!isRecord(schema) || schema.type !== "object") throw bad();
  const { properties, required } = schema;
  if (properties !== undefined && !isRecord(properties)) throw bad();
  if (
    required !== undefined &&
    !(Array.isArray(required) && required.every((r) => typeof r === "string"))
  ) {
    throw bad();
  }
  let payAmount: ToolCatalogEntry["payAmount"];
  if (raw.payAmount !== undefined) {
    if (!isRecord(raw.payAmount)) throw bad();
    payAmount = {
      amountArgPath: str(raw.payAmount.amountArgPath),
      currency: str(raw.payAmount.currency),
    };
  }
  return {
    name: str(raw.name),
    description: str(raw.description),
    inputSchema: {
      type: "object",
      ...(properties === undefined ? {} : { properties: properties as Record<string, object> }),
      ...(required === undefined ? {} : { required }),
    },
    ...(payAmount === undefined ? {} : { payAmount }),
  };
}

function parseBinding(raw: unknown): ConnectorBinding {
  if (!isRecord(raw)) throw bad();
  const access = str(raw.access);
  const provenance = str(raw.provenance);
  if (!ACCESS.includes(access) || !PROVENANCE.includes(provenance)) throw bad();
  if (typeof raw.irreversible !== "boolean") throw bad();
  return {
    tool: str(raw.tool),
    resource: str(raw.resource),
    access: access as Access,
    irreversible: raw.irreversible,
    provenance: provenance as ConnectorBinding["provenance"],
  };
}

function parseOAuth(raw: unknown): OAuthClient {
  if (!isRecord(raw) || !isRecord(raw.as)) throw bad();
  if (raw.auth_method !== "none") throw bad();
  const clientId = str(raw.client_id);
  const issuer = str(raw.as.issuer);
  const tokenEndpoint = optUrl(raw.as.token_endpoint);
  const revocationEndpoint = optUrl(raw.as.revocation_endpoint);
  return {
    as: {
      issuer,
      ...(tokenEndpoint === undefined ? {} : { token_endpoint: tokenEndpoint }),
      ...(revocationEndpoint === undefined ? {} : { revocation_endpoint: revocationEndpoint }),
    },
    client: { client_id: clientId },
    // RFC 6749 public client: identify by client_id only (what oauth4webapi's `None()` does).
    clientAuth: (_as, client, body) => {
      body.set("client_id", client.client_id);
    },
  };
}

/** `endpoints`: identifier -> `https:` or loopback `http:` URL. Anything else is refused; content is never echoed. */
function parseEndpoints(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw bad();
  const endpoints: Record<string, string> = {};
  for (const [identifier, value] of Object.entries(raw)) {
    const url = str(value);
    if (identifier === "" || !URL.canParse(url)) throw bad();
    if (new URL(url).protocol !== "https:" && !isLoopbackHttp(url)) throw bad();
    endpoints[identifier] = url;
  }
  return endpoints;
}

/** Parses already-decoded profile JSON. Throws `CliError(usage)` with a fixed message on any malformed shape. */
export function parseRunProfile(parsed: unknown): RunProfile {
  if (!isRecord(parsed)) throw bad();
  if (!Array.isArray(parsed.catalog) || !Array.isArray(parsed.bindings)) throw bad();
  try {
    const endpoints = parseEndpoints(parsed.endpoints);
    return {
      catalog: createToolCatalog((parsed.catalog as unknown[]).map(parseCatalogEntry)),
      bindings: createBindingSet((parsed.bindings as unknown[]).map(parseBinding)),
      oauth: parseOAuth(parsed.oauth),
      ...(endpoints === undefined ? {} : { endpoints }),
    };
  } catch (e) {
    // Duplicate tool names surface as a plain Error from the builders; never echo its text.
    throw e instanceof CliError ? e : bad();
  }
}

export async function loadRunProfile(file: string): Promise<RunProfile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new CliError(EXIT_CODES.usage, "The run profile could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The run profile is not valid JSON.");
  }
  return parseRunProfile(parsed);
}
