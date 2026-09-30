import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.js";

describe("payment-reconciler example skeleton", () => {
  it("resolves the package barrel", () => {
    expect(PACKAGE_NAME).toBe("@stint/example-payment-reconciler");
  });
});
