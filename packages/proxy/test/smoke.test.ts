import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME, PACKAGE_NAME } from "../src/index.js";

describe("@stint/proxy smoke", () => {
  it("reports its own package name", () => {
    expect(PACKAGE_NAME).toBe("@stint/proxy");
  });

  it("imports one symbol from its upstream workspace package", () => {
    expect(CORE_PACKAGE_NAME).toBe("@stint/core");
  });
});
