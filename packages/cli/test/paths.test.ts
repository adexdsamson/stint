import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "../src/exit.js";
import { assertSafeLeaseId, leaseDir, leaseFile, resolveStoreRoot } from "../src/paths.js";

describe("assertSafeLeaseId", () => {
  it.each([
    "../x",
    "a/b",
    "a\\b",
    "",
    "CON",
    "nul",
    "COM1",
    "lpt9.txt",
    "..",
    "a..b",
    ".hidden",
    "a".repeat(129),
  ])("rejects %j", (id) => {
    expect(() => {
      assertSafeLeaseId(id);
    }).toThrow(CliError);
  });

  it("throws a usage CliError with a fixed message", () => {
    try {
      assertSafeLeaseId("../evil");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(EXIT_CODES.usage);
      expect((e as CliError).safeMessage).not.toContain("evil");
    }
  });

  it("accepts a valid id", () => {
    expect(() => {
      assertSafeLeaseId("lease-01");
    }).not.toThrow();
    expect(() => {
      assertSafeLeaseId("a".repeat(128));
    }).not.toThrow();
  });
});

describe("leaseDir / leaseFile", () => {
  it("resolve under the store root using the dir-per-lease layout", () => {
    const root = path.resolve("some-root");
    expect(leaseDir(root, "lease-01")).toBe(path.join(root, "leases", "lease-01"));
    expect(leaseFile(root, "lease-01")).toBe(path.join(root, "leases", "lease-01", "lease.json"));
  });

  it("refuse traversal ids", () => {
    expect(() => leaseFile("root", "../x")).toThrow(CliError);
  });
});

describe("resolveStoreRoot precedence", () => {
  const original = process.env.STINT_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.STINT_HOME;
    else process.env.STINT_HOME = original;
  });

  it("prefers --store over STINT_HOME", () => {
    process.env.STINT_HOME = "from-env";
    expect(resolveStoreRoot({ store: "from-flag" })).toBe("from-flag");
  });

  it("uses STINT_HOME when no --store", () => {
    process.env.STINT_HOME = "from-env";
    expect(resolveStoreRoot({})).toBe("from-env");
  });

  it("falls back to ~/.stint", () => {
    delete process.env.STINT_HOME;
    expect(resolveStoreRoot({})).toBe(path.join(os.homedir(), ".stint"));
  });
});
