import { describe, expect, it } from "vitest";

import * as runtime from "../src/index.js";

describe("@stint/runtime public surface", () => {
  it("exposes the three entry points as functions", () => {
    expect(typeof runtime.createLeaseRuntime).toBe("function");
    expect(typeof runtime.resolveTeardown).toBe("function");
    expect(typeof runtime.settleExpired).toBe("function");
  });

  it("names the package", () => {
    expect(runtime.PACKAGE_NAME).toBe("@stint/runtime");
  });

  it("exports no concrete storage backend (D-24)", () => {
    const names = Object.keys(runtime);
    expect(names.filter((name) => name.startsWith("createFile"))).toEqual([]);
    expect(names.filter((name) => name.startsWith("createJson"))).toEqual([]);
  });
});
