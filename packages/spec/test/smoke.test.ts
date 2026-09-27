import { describe, expect, it } from "vitest";

import { SPEC_VERSION } from "../src/index.js";

describe("@stint/spec smoke", () => {
  it("exports the current spec version", () => {
    expect(SPEC_VERSION).toBe("alp/0.1");
  });
});
