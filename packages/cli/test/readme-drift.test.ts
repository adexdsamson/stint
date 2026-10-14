/**
 * Drift test for the `stint-cli verify-outcome` guide and the API-key custody
 * contract in packages/cli/README.md (Phase 10, plan 08, CLI-03, CRED-01/02).
 * The guide must name the command as registered in program.ts, its `--profile`
 * option, and the exit codes implemented in exit.ts, deriving the expected
 * numbers from EXIT_CODES itself so a code change without a doc change fails
 * here. It must also never document a way to pass the API key as a value or to
 * revoke it upstream, which the runtime does not offer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TRANSACTION_VERDICTS } from "@stint/proxy";
import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { verifyOutcomeVerdictLine } from "../src/messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const repoRoot = join(cliRoot, "..", "..");

const guide = readFileSync(join(cliRoot, "README.md"), "utf8");
const program = readFileSync(join(cliRoot, "src", "program.ts"), "utf8");
const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
const exampleReadme = readFileSync(join(repoRoot, "examples", "payment-reconciler", "README.md"), "utf8");
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");

/** The source text of the `verify-outcome` registration: from its `.command(...)` to the next registration (or the end of the factory). */
function verifyOutcomeBlock(): string {
  const start = program.indexOf('.command("verify-outcome")');
  expect(start, "verify-outcome is not registered in program.ts").toBeGreaterThanOrEqual(0);
  const nextCommand = program.indexOf(".command(", start + 1);
  const factoryEnd = program.indexOf("return program;", start);
  expect(factoryEnd).toBeGreaterThan(start);
  const end = nextCommand === -1 ? factoryEnd : Math.min(nextCommand, factoryEnd);
  return program.slice(start, end);
}

/** The verify-outcome section of the guide: from its `##` heading to the next `##` heading. */
function verifyOutcomeSection(): string {
  const start = guide.search(/^##[ \t]+.*verify-outcome/m);
  expect(start, "the guide has no ## section for verify-outcome").toBeGreaterThanOrEqual(0);
  const rest = guide.slice(start + 3);
  const next = rest.search(/^##[ \t]/m);
  return next === -1 ? guide.slice(start) : guide.slice(start, start + 3 + next);
}

/** Every `--flag` registered on `verify-outcome`. */
function registeredOptions(): string[] {
  const options: string[] = [];
  for (const match of verifyOutcomeBlock().matchAll(/\.option\(\s*"(--[a-z][a-z-]*)/g)) {
    if (match[1] !== undefined) options.push(match[1]);
  }
  return options;
}

describe("verify-outcome guide drift (plan 10-08, CLI-03)", () => {
  it("finds the --profile option registered on verify-outcome", () => {
    expect(registeredOptions()).toEqual(["--profile"]);
  });

  it("names the command and every registered option in its own section", () => {
    const section = verifyOutcomeSection();
    expect(section).toContain("stint-cli verify-outcome");
    for (const option of registeredOptions()) {
      expect(section, `the verify-outcome section does not mention ${option}`).toContain(`\`${option}`);
    }
  });

  it("documents the exit codes the command implements, taken from EXIT_CODES", () => {
    const section = verifyOutcomeSection();
    for (const code of [EXIT_CODES.ok, EXIT_CODES.wrongState, EXIT_CODES.usage, EXIT_CODES.leaseNotFound]) {
      expect(section, `missing exit code ${String(code)}`).toMatch(new RegExp(`^\\| ${String(code)} \\|`, "m"));
    }
    // The exit codes the command documents are the vocabulary the CLI already had, not new ones.
    expect(EXIT_CODES.ok).toBe(0);
    expect(EXIT_CODES.wrongState).toBe(9);
    expect(EXIT_CODES.usage).toBe(2);
  });

  it("shows the fixed verdict line and every closed verdict value", () => {
    const section = verifyOutcomeSection();
    // The documented shape is the real message with the id left as a placeholder.
    expect(section).toContain(verifyOutcomeVerdictLine("<id>", "amount_mismatch"));
    for (const verdict of TRANSACTION_VERDICTS) {
      expect(section, `missing verdict ${verdict}`).toContain(`\`${verdict}\``);
    }
  });

  it("states both verifier types and the notice-only agent signal", () => {
    const section = verifyOutcomeSection();
    expect(section).toContain("resource_query");
    expect(section).toContain("user_confirm");
    expect(section).toContain("request_outcome_check");
    expect(section).toMatch(/notice/i);
  });

  it("shows only registered subcommands in fenced stint-cli lines of the verify-outcome section", () => {
    const registered = new Set<string>();
    for (const match of program.matchAll(/\.command\("([a-z-]+)"\)/g)) {
      if (match[1] !== undefined) registered.add(match[1]);
    }
    const lines = verifyOutcomeSection()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("stint-cli "));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const name = line.split(/\s+/)[1] ?? "";
      expect(registered.has(name), `"${line}" does not start with a registered subcommand`).toBe(true);
    }
  });
});

describe("API-key custody docs (plan 10-08, CRED-01, CRED-02)", () => {
  const docs: readonly [string, string][] = [
    ["packages/cli/README.md", guide],
    ["README.md", rootReadme],
    ["examples/payment-reconciler/README.md", exampleReadme],
    ["CHANGELOG.md", changelog],
  ];

  it("states the custody contract in the CLI guide", () => {
    for (const phrase of [
      "not shown as you type",
      "one origin",
      "redirect",
      "never returned to the agent",
      "rotate",
    ]) {
      expect(guide.toLowerCase(), `the guide does not say: ${phrase}`).toContain(phrase.toLowerCase());
    }
  });

  it("documents --api-key only as a prompt switch, never a value", () => {
    expect(guide).toContain("`--api-key`");
    expect(guide).toContain("--credentials");
    for (const [name, text] of docs) {
      expect(text, `${name} shows --api-key taking a value`).not.toMatch(/--api-key(=|\s+<|\s+sk_)/u);
    }
  });

  it("never claims Stint revokes an API key upstream", () => {
    for (const [name, text] of docs) {
      expect(text, `${name} claims upstream revocation`).not.toMatch(
        /\bStint (revokes|will revoke|can revoke) (the |an |your )?(API )?key\b/i,
      );
    }
  });

  it("uses only placeholder key forms", () => {
    for (const [name, text] of docs) {
      for (const match of text.matchAll(/sk_(?:test|live)_[A-Za-z0-9_]*(?:\.\.\.)?/g)) {
        expect(["sk_test_", "sk_test_..."], `${name} shows a key-shaped value: ${match[0]}`).toContain(match[0]);
      }
    }
  });

  it("has no em-dash and no sandbox-only pnpm workaround in the phase docs", () => {
    // The CHANGELOG predates the rule (one older entry has an em-dash), so only the READMEs are scanned.
    for (const [name, text] of docs) {
      if (name === "CHANGELOG.md") continue;
      expect(text, `${name} has an em-dash`).not.toContain("—");
    }
    expect(guide).not.toContain("npx --yes pnpm");
    expect(exampleReadme).not.toContain("npx --yes pnpm");
  });
});

describe("README links for the payment-confirmation example (plan 10-08)", () => {
  it("links the example README from the root README in prose", () => {
    expect(rootReadme).toContain("examples/payment-reconciler/README.md");
    expect(rootReadme).toContain("payment-confirmation");
  });

  it("documents the gated e2e as optional and never as a CI requirement", () => {
    expect(exampleReadme).toContain("PAYSTACK_TEST_SECRET_KEY");
    expect(exampleReadme).toMatch(/skipped/i);
    expect(exampleReadme).not.toMatch(/\brequired for CI\b/i);
  });
});
