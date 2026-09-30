/**
 * README drift test (DOC-01, D-13): the README keeps its four sections in
 * order, and every command it documents in a fenced block is a real package
 * script or a real `stint` subcommand. A renamed script or a dropped section
 * fails the build instead of silently rotting the docs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Walks up from this file to the workspace root (the dir holding pnpm-workspace.yaml). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("pnpm-workspace.yaml not found above the test file");
    }
    dir = parent;
  }
}

const root = findRepoRoot();
const readme = readFileSync(join(root, "README.md"), "utf8");
const rootScripts = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
const exampleScripts = (
  JSON.parse(
    readFileSync(join(root, "examples", "payment-reconciler", "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  }
).scripts;
const cliProgram = readFileSync(join(root, "packages", "cli", "src", "program.ts"), "utf8");

/** `##` headings only (not `#` or `###`), with the offset of each in the README. */
function sectionHeadings(): { title: string; index: number }[] {
  const headings: { title: string; index: number }[] = [];
  const pattern = /^##[ \t]+(.+?)[ \t]*$/gm;
  for (let match = pattern.exec(readme); match !== null; match = pattern.exec(readme)) {
    headings.push({ title: match[1] ?? "", index: match.index });
  }
  return headings;
}

/** Every non-empty line inside fenced code blocks, with any leading `$ ` prompt removed. */
function fencedCommands(): string[] {
  const commands: string[] = [];
  const pattern = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (let match = pattern.exec(readme); match !== null; match = pattern.exec(readme)) {
    for (const line of (match[1] ?? "").split("\n")) {
      const command = line.replace(/^\$\s+/, "").trim();
      if (command !== "") {
        commands.push(command);
      }
    }
  }
  return commands;
}

function cliSubcommands(): Set<string> {
  const names = new Set<string>();
  for (const match of cliProgram.matchAll(/\.command\("([a-z-]+)"\)/g)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

describe("README drift (DOC-01)", () => {
  it("has the four sections, as ## headings, in order: problem, auth modes, hosted trust limits, quickstart", () => {
    const headings = sectionHeadings();
    const find = (test: (title: string) => boolean): number =>
      headings.find((heading) => test(heading.title.toLowerCase()))?.index ?? -1;

    const problem = find((title) => title.includes("problem"));
    const authModes = find((title) => title.includes("auth") && title.includes("mode"));
    const trustLimits = find((title) => title.includes("trust") && title.includes("limit"));
    const quickstart = find((title) => title.includes("quickstart"));

    for (const [name, index] of Object.entries({ problem, authModes, trustLimits, quickstart })) {
      expect(index, `missing ## section: ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(problem).toBeLessThan(authModes);
    expect(authModes).toBeLessThan(trustLimits);
    expect(trustLimits).toBeLessThan(quickstart);
  });

  it("documents exactly the fresh-clone quickstart commands, each a real script", () => {
    const pnpmCommands = fencedCommands().filter((command) => command.startsWith("pnpm "));
    expect(pnpmCommands).toEqual(["pnpm install", "pnpm build", "pnpm example:payment-reconciler"]);

    // `install` is a built-in pnpm command; the rest must be scripts in the root package.json.
    expect(rootScripts).toHaveProperty("build");
    expect(rootScripts).toHaveProperty("example:payment-reconciler");
    // The wrapped command must still resolve to the example package's real start script.
    expect(rootScripts["example:payment-reconciler"]).toContain(
      "@stint/example-payment-reconciler",
    );
    expect(exampleScripts).toHaveProperty("start");

    // The sandbox-only pnpm workaround is a developer note, never user-facing.
    expect(readme).not.toContain("npx --yes pnpm");
  });

  it("documents the individual lifecycle using only real stint subcommands", () => {
    const stintCommands = fencedCommands().filter((command) => command.startsWith("stint "));
    const documented = stintCommands.map((command) => command.split(/\s+/)[1] ?? "");
    const real = cliSubcommands();

    expect(documented).toEqual(["create", "run", "revoke", "cleanup", "receipts", "verify"]);
    for (const name of documented) {
      expect(real.has(name), `stint ${name} is not a real CLI subcommand`).toBe(true);
    }
  });

  it("names the three auth modes with hybrid as the default, and explains verified vs attested", () => {
    for (const mode of ["delegated", "hosted", "hybrid"]) {
      expect(readme).toContain(`\`${mode}\``);
    }
    expect(readme).toMatch(/`hybrid`[^.\n]*default|default[^.\n]*`hybrid`/i);
    expect(readme).toContain("verified");
    expect(readme).toContain("attested");
    expect(readme).toContain("[verified]");
    expect(readme).toContain("cleanup_hook: attested_ok");
  });
});
