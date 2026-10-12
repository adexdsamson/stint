import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const FORBIDDEN_MODULES = ["node:fs", "node:os", "node:path", "node:child_process"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Strips block and line comments so prose that names a forbidden module is not mistaken for an import. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(m[1] ?? "");
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1] ?? "");
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1] ?? "");
  return specs;
}

describe("@stint/runtime is host-agnostic (D-24)", () => {
  const files = sourceFiles(SRC_DIR);

  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports no node file-system, os, path or child-process module and nothing from @stint/cli", () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const spec of importSpecifiers(code)) {
        expect(FORBIDDEN_MODULES, `${path.basename(file)} imports ${spec}`).not.toContain(spec);
        expect(spec.startsWith("@stint/cli"), `${path.basename(file)} imports ${spec}`).toBe(false);
      }
    }
  });

  it("never references the process global", () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, path.basename(file)).not.toMatch(/\bprocess\b/);
    }
  });
});
