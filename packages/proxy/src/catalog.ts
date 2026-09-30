/**
 * Runtime-owned, agent-facing tool catalog (D-08, D-12). A `ToolCatalogEntry`
 * supplies the MCP presentation fields (`name`, `description`,
 * `inputSchema`) `tools/list` advertises -- paired with (never merged into)
 * `@stint/core`'s `ConnectorBinding`, which stays classification-only
 * (`resource`/`access`/`irreversible`/`provenance`). Nothing agent- or
 * publisher-supplied, and nothing fetched live from a downstream resource,
 * ever drives this catalog; it is always injected at proxy construction
 * (D-12), never derived from the manifest (T-04-02-TP).
 *
 * Mirrors `@stint/core/src/bindings.ts`'s own-property-keyed `Record` +
 * guarded builder + guarded lookup pattern exactly, including the
 * `Object.hasOwn` guard against prototype-pollution tool names (`__proto__`,
 * `constructor`).
 */

/**
 * A single tool's agent-facing MCP presentation (D-08). `inputSchema` is
 * JSON-Schema-shaped (`type: "object"`), matching the low-level `Server`'s
 * wire `Tool.inputSchema` field with no conversion (RESEARCH.md Pattern 1 /
 * Pitfall 1).
 */
export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
  };
  /**
   * Runtime-owned pay-amount descriptor (D-07, PRXY-04). Declares WHICH
   * resolved arg holds the minor-unit spend amount for a `pay`-classified
   * tool -- never derived from the manifest or anything the agent supplies.
   * Absent for every non-pay tool. `currency` is carried for future
   * `limits.spend.currency` cross-checks; this plan enforces amount only
   * (flagged assumption, see PLAN.md).
   */
  readonly payAmount?: {
    readonly amountArgPath: string;
    readonly currency: string;
  };
}

/** Runtime-owned lookup keyed by tool name, mirroring `@stint/core`'s `BindingSet` shape. */
export type ToolCatalog = Readonly<Record<string, ToolCatalogEntry>>;

/**
 * Builds a `ToolCatalog` from a flat list of entries, keyed by `entry.name`.
 * Throws a plain `Error` on a duplicate `name` -- two catalog entries for
 * the same tool is a runtime configuration bug, not a recoverable `Result`
 * case (mirrors `createBindingSet`).
 */
export function createToolCatalog(entries: readonly ToolCatalogEntry[]): ToolCatalog {
  const catalog: Record<string, ToolCatalogEntry> = {};
  for (const entry of entries) {
    if (Object.hasOwn(catalog, entry.name)) {
      throw new Error(`@stint/proxy: duplicate tool catalog entry for tool "${entry.name}".`);
    }
    catalog[entry.name] = entry;
  }
  return catalog;
}

/**
 * Looks up `name` as an OWN property of `catalog` -- never a bare bracket
 * access alone, so prototype-named tool names (`__proto__`, `constructor`)
 * can never reach `Object.prototype` (mirrors `resolveBinding`). Returns
 * `undefined` for any unregistered tool.
 */
export function resolveCatalogEntry(catalog: ToolCatalog, name: string): ToolCatalogEntry | undefined {
  if (!Object.hasOwn(catalog, name)) return undefined;
  return catalog[name];
}

/**
 * Extracts the pre-authorization minor-unit spend amount for `entry`'s call
 * (D-07, PRXY-04) -- `undefined` for a non-pay/absent `payAmount` descriptor.
 * Reads `resolvedArgs` as an OWN property at `payAmount.amountArgPath` --
 * never a bare bracket access alone -- so a prototype-named arg path
 * (`__proto__`, `constructor`) can never reach `Object.prototype` (mirrors
 * `resolveCatalogEntry`/`resolveBinding`'s guard). Returns `undefined` when
 * the path is absent or the value is not a non-negative integer -- never
 * throws on a malformed/adversarial arg.
 *
 */
export function extractSpendMinor(
  entry: ToolCatalogEntry,
  resolvedArgs: Readonly<Record<string, unknown>>,
): number | undefined {
  if (entry.payAmount === undefined) return undefined;
  const { amountArgPath } = entry.payAmount;
  if (!Object.hasOwn(resolvedArgs, amountArgPath)) return undefined;
  const value = resolvedArgs[amountArgPath];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}
