/**
 * `createLeaseProxyServer` -- constructs the agent-facing, low-level
 * `@modelcontextprotocol/sdk` `Server`, one per `leaseId` (D-10). `Server`,
 * not `McpServer`, is used deliberately: `McpServer.registerTool()`'s
 * `inputSchema` is Zod-typed only, while the runtime-owned catalog (D-08)
 * is JSON-Schema-shaped and needs zero conversion against the low-level
 * `Server`'s wire `Tool.inputSchema` field (RESEARCH.md Pattern 1 /
 * Pitfall 1).
 *
 * `tools/list` is computed once at construction, filtering the injected
 * catalog x `BindingSet` by this lease's granted scopes/resources
 * (`dispatch.ts`'s `resolveEffectiveBinding` -- the SAME filter
 * `tools/call` uses for authorization, so nothing visible-vs-invocable can
 * drift, T-04-02-TP/T-04-02-DN). The single `CallToolRequestSchema` handler
 * is the ONE dispatch point every `tools/call` flows through
 * (`dispatch.ts`'s `handleCall`).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BindingSet, LeaseStore, ReceiptStore } from "@stint/core";
import type { Access, Approvals, Limits } from "@stint/spec";

import type { ToolCatalog } from "./catalog.js";
import { resolveCatalogEntry } from "./catalog.js";
import type { ApprovalStage, CapEnforcer, ExecuteStage } from "./dispatch.js";
import { handleCall, resolveEffectiveBinding } from "./dispatch.js";

/**
 * Every construction-time dependency `createLeaseProxyServer` and
 * `handleCall` (`dispatch.ts`) need. `catalog`/`bindings` are runtime-owned
 * and injected, never derived from the manifest or a downstream fetch
 * (D-08, D-12). `execute`/`approve`/`enforceCaps` are the three seams
 * plans 04-03/04-04/04-05 implement against without editing `dispatch.ts`.
 */
export interface ProxyDeps {
  readonly leaseId: string;
  readonly leaseStore: LeaseStore;
  readonly receiptStore: ReceiptStore;
  readonly catalog: ToolCatalog;
  readonly bindings: BindingSet;
  readonly grantedScopes: readonly Access[];
  readonly grantedResources: readonly string[];
  readonly limits: Limits;
  readonly approvals: Approvals;
  readonly clock: () => number;
  readonly execute: ExecuteStage;
  readonly approve: ApprovalStage;
  readonly enforceCaps: CapEnforcer;
}

function toWireTool(name: string, catalog: ToolCatalog): Tool {
  const entry = resolveCatalogEntry(catalog, name);
  if (entry === undefined) {
    // unreachable: `name` is always drawn from `Object.keys(catalog)` below.
    throw new Error(`@stint/proxy: catalog entry "${name}" not found while building tools/list.`);
  }
  // The wire `Tool` type wants mutable arrays; the catalog entry's own
  // `inputSchema` stays `readonly` (D-08's runtime-owned, never-mutated
  // discipline) -- this is a one-way conversion at the boundary, never a
  // shared reference the agent could influence.
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: {
      type: entry.inputSchema.type,
      ...(entry.inputSchema.properties !== undefined
        ? { properties: { ...entry.inputSchema.properties } }
        : {}),
      ...(entry.inputSchema.required !== undefined ? { required: [...entry.inputSchema.required] } : {}),
    },
  };
}

/**
 * Constructs the agent-facing `Server` for exactly one lease. `tools/list`
 * is a static handler computed once here -- never recomputed per request,
 * never influenced by anything the agent supplies (D-10).
 *
 * The low-level `Server` is deliberately used instead of `McpServer`: its
 * own `@deprecated` note reads "Only use `Server` for advanced use cases"
 * -- a per-lease, policy-gated, statically-filtered tool list is exactly
 * that. `McpServer.registerTool()`'s `inputSchema` is Zod-typed only, while
 * the runtime-owned catalog (D-08) is JSON-Schema-shaped and needs zero
 * conversion against `Server`'s wire `Tool.inputSchema` field (RESEARCH.md
 * Pattern 1 / Pitfall 1).
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see docstring above; Server is the correct choice here, not McpServer.
export function createLeaseProxyServer(deps: ProxyDeps): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see docstring above; Server is the correct choice here, not McpServer.
  const server = new Server({ name: "stint-proxy", version: "0.1.0" }, { capabilities: { tools: {} } });

  const visibleTools: Tool[] = Object.keys(deps.catalog)
    .filter(
      (name) =>
        resolveEffectiveBinding(deps.bindings, deps.grantedScopes, deps.grantedResources, name) !== undefined,
    )
    .map((name) => toWireTool(name, deps.catalog));

  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: visibleTools }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const now = deps.clock();
    return handleCall(deps, request.params, now);
  });

  return server;
}
