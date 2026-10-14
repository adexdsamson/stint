/**
 * Drift test for the `stint-cli supervise` operator guide (Phase 9 D-24). The
 * guide in packages/cli/README.md must name every flag the `supervise` command
 * registers in program.ts, carry the same defaults, document the exit codes and
 * stuck reasons, and show only commands that exist. A renamed flag or a changed
 * default fails here instead of leaving the guide wrong.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const repoRoot = join(cliRoot, "..", "..");

const guide = readFileSync(join(cliRoot, "README.md"), "utf8");
const program = readFileSync(join(cliRoot, "src", "program.ts"), "utf8");
const messages = readFileSync(join(cliRoot, "src", "messages.ts"), "utf8");
const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");

/** The source text of the `supervise` registration: from its `.command(...)` to the next registration (or the end of the factory). */
function superviseBlock(): string {
  const start = program.indexOf('.command("supervise")');
  expect(start, "supervise is not registered in program.ts").toBeGreaterThanOrEqual(0);
  const nextCommand = program.indexOf(".command(", start + 1);
  const factoryEnd = program.indexOf("return program;", start);
  expect(factoryEnd).toBeGreaterThan(start);
  const end = nextCommand === -1 ? factoryEnd : Math.min(nextCommand, factoryEnd);
  return program.slice(start, end);
}

/** Every `--flag` registered on `supervise`, with the number in its `(default N)` description when it has one. */
function superviseFlags(): { flag: string; defaultValue: string | undefined }[] {
  const flags: { flag: string; defaultValue: string | undefined }[] = [];
  const pattern = /\.option\(\s*"(--[a-z][a-z-]*)[^"]*",\s*"([^"]*)"/g;
  const block = superviseBlock();
  for (let match = pattern.exec(block); match !== null; match = pattern.exec(block)) {
    const defaultValue = /\(default (\d+)\)/.exec(match[2] ?? "")?.[1];
    flags.push({ flag: match[1] ?? "", defaultValue });
  }
  return flags;
}

/** The four stuck reasons, read from the exhaustive switch in `sweepStuckLine`. */
function stuckReasons(): string[] {
  const start = messages.indexOf("export function sweepStuckLine");
  expect(start, "sweepStuckLine not found in messages.ts").toBeGreaterThanOrEqual(0);
  const body = messages.slice(start, messages.indexOf("\n}\n", start));
  return [...body.matchAll(/case "([a-z_]+)":/g)].map((match) => match[1] ?? "");
}

/** Every non-empty line inside fenced code blocks, with any leading `$ ` prompt removed. */
function fencedLines(): string[] {
  const lines: string[] = [];
  const pattern = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (let match = pattern.exec(guide); match !== null; match = pattern.exec(guide)) {
    for (const line of (match[1] ?? "").split("\n")) {
      const command = line.replace(/^\$\s+/, "").trim();
      if (command !== "") lines.push(command);
    }
  }
  return lines;
}

function registeredSubcommands(): Set<string> {
  const names = new Set<string>();
  for (const match of program.matchAll(/\.command\("([a-z-]+)"\)/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

describe("supervise operator guide drift (D-24)", () => {
  it("finds the supervise flags in program.ts", () => {
    const flags = superviseFlags().map((entry) => entry.flag);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--once",
        "--sweep-interval",
        "--retry-base",
        "--retry-max",
        "--retry-cap",
        "--probe-interval",
        "--corrupt-repeat",
        "--clock-jump-threshold",
        "--confirm-clock",
      ]),
    );
  });

  it("names every flag registered on supervise", () => {
    for (const { flag } of superviseFlags()) {
      expect(guide, `the guide does not mention ${flag}`).toContain(`\`${flag}`);
    }
  });

  it("gives each flag the same default as its help text", () => {
    for (const { flag, defaultValue } of superviseFlags()) {
      if (defaultValue === undefined) continue;
      const row = guide.split("\n").find((line) => line.startsWith(`| \`${flag}`));
      expect(row, `no flag table row for ${flag}`).toBeDefined();
      expect(row, `the ${flag} row does not show default ${defaultValue}`).toContain(`| ${defaultValue} |`);
    }
  });

  it("names the four service setups and the key flags", () => {
    for (const term of ["Task Scheduler", "systemd", "launchd", "cron", "--once", "--confirm-clock"]) {
      expect(guide, `missing ${term}`).toContain(term);
    }
  });

  it("names every stuck reason", () => {
    const reasons = stuckReasons();
    expect(reasons).toHaveLength(4);
    for (const reason of reasons) {
      expect(guide, `missing stuck reason ${reason}`).toContain(`\`${reason}\``);
    }
  });

  it("documents the --once exit codes 7, 8 and 10", () => {
    for (const code of ["7", "8", "10"]) {
      expect(guide, `missing exit code ${code}`).toMatch(new RegExp(`^\\| ${code} \\|`, "m"));
    }
  });

  it("states the retry window and the single invalid_grant caveat", () => {
    expect(guide).toContain("about 3 hours");
    expect(guide).toContain("invalid_grant");
    expect(guide).toMatch(/inactivity/i);
    expect(guide).toMatch(/IP address/);
  });

  it("shows only real subcommands in fenced stint-cli lines", () => {
    const real = registeredSubcommands();
    const shown = fencedLines().filter((line) => line.startsWith("stint-cli "));
    expect(shown.length).toBeGreaterThan(0);
    for (const line of shown) {
      const words = line.split(/\s+/).slice(1);
      // Skip the global flags that may come first.
      let index = 0;
      while (words[index]?.startsWith("--") === true) index += words[index] === "--store" ? 2 : 1;
      const name = words[index] ?? "";
      expect(real.has(name), `"${line}" does not start with a registered subcommand`).toBe(true);
    }
  });

  it("documents no install, abandon or status command for the supervisor", () => {
    for (const line of fencedLines()) {
      expect(line).not.toMatch(/stint-cli\s+(install|abandon|status|uninstall)\b/);
      expect(line).not.toMatch(/supervise\s+(install|abandon|status|uninstall)\b/);
    }
  });

  it("has no em-dash and no sandbox-only pnpm workaround", () => {
    expect(guide).not.toContain("—");
    expect(guide).not.toContain("npx --yes pnpm");
  });

  it("is linked from the root README in prose only", () => {
    expect(rootReadme).toContain("packages/cli/README.md");
    expect(rootReadme).toContain("`stint-cli supervise`");
  });
});
