import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  PACKAGE_NAME,
  PROXY_PACKAGE_NAME,
  buildProgram,
  createJsonLeaseStore,
  createJsonReceiptStore,
  createRealDeps,
  createTerminalHostAdapter,
  main,
  runLease,
} from "../src/index.js";

describe("@stint/cli public barrel", () => {
  it.each([
    ["createJsonLeaseStore", createJsonLeaseStore],
    ["createJsonReceiptStore", createJsonReceiptStore],
    ["createTerminalHostAdapter", createTerminalHostAdapter],
    ["buildProgram", buildProgram],
    ["main", main],
    ["runLease", runLease],
    ["createRealDeps", createRealDeps],
  ])("exports %s as a function", (_name, value) => {
    expect(typeof value).toBe("function");
  });

  it("keeps the package names and the exit-code map", () => {
    expect(PACKAGE_NAME).toBe("@stint/cli");
    expect(PROXY_PACKAGE_NAME).toBe("@stint/proxy");
    expect(EXIT_CODES.cleanupIncomplete).toBe(7);
  });
});
