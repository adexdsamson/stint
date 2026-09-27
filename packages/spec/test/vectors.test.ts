import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateManifest } from "../src/validate.js";
import { paymentReconcilerManifest } from "./fixtures.js";

// packages/spec/test -> packages/spec -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors");

interface ExpectedError {
  readonly path: string;
  readonly code: string;
}

interface ValidVectorFile {
  readonly description: string;
  readonly manifest: unknown;
}

interface InvalidVectorFile {
  readonly description: string;
  readonly manifest: unknown;
  readonly expected_errors: readonly ExpectedError[];
}

function readVectorFiles(kind: "valid" | "invalid"): { name: string; path: string }[] {
  const dir = path.join(vectorsDir, kind);
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => ({ name: entry, path: path.join(dir, entry) }));
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("vectors", () => {
  it("every valid vector validates", () => {
    const files = readVectorFiles("valid");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const vector = readJson(file.path) as ValidVectorFile;
      const result = validateManifest(vector.manifest);
      expect(result.ok, `${file.name}: ${result.ok ? "" : JSON.stringify(result.errors)}`).toBe(true);
    }
  });

  it("every invalid vector yields exactly its expected errors", () => {
    const files = readVectorFiles("invalid");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const vector = readJson(file.path) as InvalidVectorFile;
      const result = validateManifest(vector.manifest);
      expect(result.ok, `${file.name} unexpectedly valid`).toBe(false);
      if (!result.ok) {
        const got = new Set(result.errors.map((error) => `${error.path}\u0000${error.code}`));
        const expected = new Set(vector.expected_errors.map((error) => `${error.path}\u0000${error.code}`));
        expect(got, file.name).toEqual(expected);
      }
    }
  });

  it("payment-reconciler vector equals the test fixture", () => {
    const vector = readJson(path.join(vectorsDir, "valid", "payment-reconciler.json")) as ValidVectorFile;
    expect(vector.manifest).toEqual(paymentReconcilerManifest());
  });
});
