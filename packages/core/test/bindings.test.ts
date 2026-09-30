import { describe, expect, it } from "vitest";

import { createBindingSet, resolveBinding } from "../src/bindings.js";
import type { ConnectorBinding } from "../src/bindings.js";

function sheetsAppend(): ConnectorBinding {
  return {
    tool: "sheets.append",
    resource: "sheets",
    access: "write",
    irreversible: false,
    provenance: "built_in",
  };
}

describe("createBindingSet / resolveBinding", () => {
  it("resolves a registered tool to its binding", () => {
    const set = createBindingSet([sheetsAppend()]);

    expect(resolveBinding(set, "sheets.append")).toEqual(sheetsAppend());
  });

  it("returns undefined for an unregistered tool", () => {
    const set = createBindingSet([sheetsAppend()]);

    expect(resolveBinding(set, "unknown.tool")).toBeUndefined();
  });

  it("returns undefined for a prototype-named tool ('__proto__') — no prototype leakage", () => {
    const set = createBindingSet([sheetsAppend()]);

    expect(resolveBinding(set, "__proto__")).toBeUndefined();
  });

  it("throws when two bindings share the same tool name", () => {
    const duplicate: ConnectorBinding = {
      tool: "sheets.append",
      resource: "sheets",
      access: "read",
      irreversible: false,
      provenance: "user_approved_custom",
    };

    expect(() => createBindingSet([sheetsAppend(), duplicate])).toThrow();
  });

  it("builds an empty BindingSet from an empty list", () => {
    const set = createBindingSet([]);

    expect(resolveBinding(set, "anything")).toBeUndefined();
  });
});
