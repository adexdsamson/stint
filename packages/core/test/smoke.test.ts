import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, SPEC_VERSION } from "../src/index.js";

describe("@stint/core smoke", () => {
  it("re-exports SPEC_VERSION from @stint/spec", () => {
    expect(SPEC_VERSION).toBe("alp/0.1");
  });

  it("reports its own package name", () => {
    expect(PACKAGE_NAME).toBe("@stint/core");
  });
});
