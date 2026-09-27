/**
 * Runtime-owned connector bindings (D-11, D-12). A `ConnectorBinding` maps a
 * tool the proxy exposes to its `(resource, access, irreversible)`
 * classification. Bindings are runtime-owned — NEVER derived from manifest
 * content (spec/ALP.md Section 9: "the runtime never derives a binding from
 * manifest content"). The manifest never names a tool, and nothing in a
 * manifest can change a tool's classification; `evaluatePolicy` (policy.ts)
 * only ever reads a resolved `ConnectorBinding | undefined`, never the
 * manifest itself (PRXY-03).
 *
 * `provenance` distinguishes a binding the runtime ships built-in from one a
 * user has explicitly approved as a custom binding, so a run can require an
 * approved custom binding if it wants (D-12).
 */

import type { Access } from "@stint/spec";

/** Distinguishes runtime-shipped bindings from user-approved custom ones (D-12). */
export type BindingProvenance = "built_in" | "user_approved_custom";

/** A single tool's runtime-owned classification. `access` is only ever `read | write | send | pay` (D-12). */
export interface ConnectorBinding {
  readonly tool: string;
  readonly resource: string;
  readonly access: Access;
  readonly irreversible: boolean;
  readonly provenance: BindingProvenance;
}

/** Runtime-owned lookup keyed by tool name, mirroring `@stint/spec`'s `TrustStore` keyed-`Record` shape. */
export type BindingSet = Readonly<Record<string, ConnectorBinding>>;

/**
 * Builds a `BindingSet` from a flat list of bindings, keyed by `binding.tool`.
 * Throws a plain `Error` on a duplicate `tool` name (mirroring the guard-clause
 * style in `@stint/spec`'s `testing.ts`) — two bindings for the same tool is a
 * runtime configuration bug, not a recoverable `Result` case.
 */
export function createBindingSet(bindings: readonly ConnectorBinding[]): BindingSet {
  const set: Record<string, ConnectorBinding> = {};
  for (const binding of bindings) {
    if (Object.hasOwn(set, binding.tool)) {
      throw new Error(`@stint/core: duplicate connector binding for tool "${binding.tool}".`);
    }
    set[binding.tool] = binding;
  }
  return set;
}

/**
 * Looks up `tool` as an OWN property of `set` — never a bare bracket access
 * alone, so prototype-named tool names (`__proto__`, `constructor`) can never
 * reach `Object.prototype` (mirrors `ownEntry` in `@stint/spec`'s `envelope.ts`).
 * Returns `undefined` for any unregistered tool, which drives `evaluatePolicy`'s
 * deny-by-default `no_binding` decision (PRXY-02).
 */
export function resolveBinding(set: BindingSet, tool: string): ConnectorBinding | undefined {
  if (!Object.hasOwn(set, tool)) return undefined;
  return set[tool];
}
