/**
 * 10-06 Task 3: a JSON run profile may NAME the built-in `verdict` row adapter
 * for a binding (a function is not JSON). The only allowed name maps to the
 * proxy's exported `verdictRowAdapter`; any other string is the fixed bad-shape
 * usage error, and a binding with no `rowAdapter` parses exactly as before.
 */

import { verdictRowAdapter } from "@stint/proxy";
import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { parseRunProfile } from "../src/run/profile.js";
import { PROFILE_JSON } from "./helpers/run-fixture.js";

function withBinding(extra: Record<string, unknown>): unknown {
  const base = JSON.parse(JSON.stringify(PROFILE_JSON)) as typeof PROFILE_JSON;
  return { ...base, bindings: [{ ...base.bindings[0], ...extra }, ...base.bindings.slice(1)] };
}

describe("parseRunProfile: the named verdict row adapter", () => {
  it('maps "rowAdapter": "verdict" to the exported verdictRowAdapter (identity, not shape)', () => {
    const profile = parseRunProfile(withBinding({ rowAdapter: "verdict" }));
    const [first] = PROFILE_JSON.bindings;
    expect(profile.bindings[first.tool]?.rowAdapter).toBe(verdictRowAdapter);
  });

  it("leaves a binding with no rowAdapter exactly as before (no adapter member)", () => {
    const profile = parseRunProfile(PROFILE_JSON);
    for (const binding of Object.values(profile.bindings)) {
      expect(binding.rowAdapter).toBeUndefined();
    }
  });

  const rejected: Array<[string, unknown]> = [
    ["an unknown adapter name", "orders"],
    ["the empty string", ""],
    ["a differently cased name", "Verdict"],
    ["a non-string", 1],
    ["an object", { name: "verdict" }],
    ["null", null],
  ];
  it.each(rejected)("rejects %s with the fixed bad-shape usage error", (_name, value) => {
    let thrown: unknown;
    try {
      parseRunProfile(withBinding({ rowAdapter: value }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      code: EXIT_CODES.usage,
      safeMessage: "The run profile has an unexpected shape.",
    });
  });
});
