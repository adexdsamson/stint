import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

// packages/spec/test -> packages/spec -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
const codegenScript = path.join(repoRoot, "packages", "spec", "scripts", "codegen.mjs");
const specDir = path.join(repoRoot, "spec");

function runCodegen(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [codegenScript, ...args], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("codegen", () => {
  it("codegen check passes on committed output", () => {
    const { status, stderr } = runCodegen(["--check"]);
    expect(status, stderr).toBe(0);
  });

  it("codegen check detects stale types", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "stint-codegen-drift-"));
    try {
      // Copy every committed schema so codegen (which reads all spec/*.schema.json
      // targets) resolves each one; mutating the manifest below is what triggers the
      // stale-type detection this test asserts on.
      for (const schemaFile of readdirSync(specDir).filter((f) => f.endsWith(".schema.json"))) {
        cpSync(path.join(specDir, schemaFile), path.join(tempDir, schemaFile));
      }

      const manifestSchemaPath = path.join(tempDir, "manifest.schema.json");
      const manifestSchema = JSON.parse(readFileSync(manifestSchemaPath, "utf8")) as {
        definitions: { Agent: { properties: Record<string, unknown> } };
      };
      manifestSchema.definitions.Agent.properties.nickname = { type: "string" };
      writeFileSync(manifestSchemaPath, JSON.stringify(manifestSchema, null, 2));

      const { status, stderr } = runCodegen(["--check", "--schema-dir", tempDir]);
      expect(status).toBe(1);
      expect(stderr).toContain("stale");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("schemas compile in Ajv strict mode", () => {
    const manifestSchema = JSON.parse(readFileSync(path.join(specDir, "manifest.schema.json"), "utf8")) as object;
    const envelopeSchema = JSON.parse(readFileSync(path.join(specDir, "envelope.schema.json"), "utf8")) as object;

    const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
    addFormats.default(ajv);

    expect(() => {
      ajv.compile(manifestSchema);
      ajv.compile(envelopeSchema);
    }).not.toThrow();
  });
});
