import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, PROXY_PACKAGE_NAME } from "../src/index.js";

describe("@stint/cli smoke", () => {
  it("reports its own package name", () => {
    expect(PACKAGE_NAME).toBe("@stint/cli");
  });

  it("imports one symbol from its upstream workspace package", () => {
    expect(PROXY_PACKAGE_NAME).toBe("@stint/proxy");
  });
});
