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
import type { BindingSet, LeaseStore, LifecycleEvent, ReceiptStore, Telemetry } from "@stint/core";
import type { Access, Approvals, Limits } from "@stint/spec";

import type { ToolCatalog } from "./catalog.js";
import { resolveCatalogEntry } from "./catalog.js";
import type { ApprovalStage, CapEnforcer, ExecuteStage } from "./dispatch.js";
import {
  OUTCOME_CHECK_DESCRIPTION,
  OUTCOME_CHECK_TOOL,
  handleCall,
  resolveEffectiveBinding,
} from "./dispatch.js";
import type { TeardownFenceConfig } from "./teardown/fence.js";
import type { TeardownStep } from "./teardown/steps.js";

/**
 * Every construction-time dependency `createLeaseProxyServer` and
 * `handleCall` (`dispatch.ts`) need. `catalog`/`bindings` are runtime-owned
 * and injected, never derived from the manifest or a downstream fetch
 * (D-08, D-12). `execute`/`approve`/`enforceCaps` are the three seams
 * plans 04-03/04-04/04-05 implement against without editing `dispatch.ts`.
 *
 * `teardownSteps` (05-03, TEAR-01) is optional: when supplied, a provider
 * revocation drives the full teardown orchestrator (`teardown/orchestrate.ts`'s
 * `runTeardown`) after the triggering call's own transaction commits, in its
 * OWN per-lease transaction (never nested). Omitting it (every pre-05-03
 * `ProxyDeps` literal) leaves the lease at `tearing_down` after the
 * auto-chained `begin_teardown` -- still a legal, honestly-receipted state,
 * just without the steps having run.
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
  readonly teardownSteps?: readonly TeardownStep[];
  /**
   * OPTIONAL (Phase 9 D-09): the teardown fence. Every driver of a teardown
   * pass is fenced, a live `run` included: when set, the call-triggered
   * teardown holds the lease-record fence for its pass, and a pass another
   * driver already owns (`TeardownFencedError`) is left to that driver without
   * failing or changing the call's own result. Absent keeps the unfenced
   * Phase 8 behaviour.
   */
  readonly teardownFence?: TeardownFenceConfig;
  /** How often, in milliseconds, a call waiting for an approval polls the lease store to notice the lease ending (D-20). Default 1000. */
  readonly approvalWatchMs?: number;
  /** Optional observational sink; one `call.decided` event per call (D-25). */
  readonly telemetry?: Telemetry;
  /**
   * OPTIONAL (Phase 10, SPEC-11): tells the user's host that the agent asked for an outcome check
   * (`request_outcome_check`). Best effort and notice-only: a failure here never changes the call's
   * result, and nothing it does can complete a lease. Absent means the call is receipted and answered
   * with no notification.
   */
  readonly notify?: (event: LifecycleEvent) => Promise<void>;
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

  // The fixed signal tool is listed beside the catalog (SPEC-11). It is not a catalog entry and has no
  // binding; a catalog entry that reuses its name is skipped so the name appears once and is never shadowed.
  const visibleTools: Tool[] = Object.keys(deps.catalog)
    .filter(
      (name) =>
        name !== OUTCOME_CHECK_TOOL &&
        resolveEffectiveBinding(deps.bindings, deps.grantedScopes, deps.grantedResources, name) !== undefined,
    )
    .map((name) => toWireTool(name, deps.catalog));
  visibleTools.push({
    name: OUTCOME_CHECK_TOOL,
    description: OUTCOME_CHECK_DESCRIPTION,
    inputSchema: { type: "object", properties: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: visibleTools }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const now = deps.clock();
    return handleCall(deps, request.params, now);
  });

  return server;
}
