import type { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { buildProgram, main } from "../src/program.js";
import { createHarness } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("buildProgram / main", () => {
  it("registers exactly the seven D-03 commands", async () => {
    h = await createHarness();
    const names = buildProgram(h.deps).commands.map((c) => c.name());
    expect(names).toEqual(["create", "inspect", "run", "revoke", "cleanup", "receipts", "verify"]);
  });

  it("--help resolves to exit 0 through mapCommander and writes via the injected io", async () => {
    h = await createHarness();
    const code = await main(["--help"], h.deps);
    expect(code).toBe(0);
    expect(h.stdout.join("")).toContain("Usage: stint");
  });

  it("--version resolves to exit 0", async () => {
    h = await createHarness();
    expect(await main(["--version"], h.deps)).toBe(0);
  });

  it.each([
    ["an unknown command", ["frobnicate"]],
    ["a missing argument", ["inspect"]],
    ["an unknown option", ["inspect", "x", "--nope"]],
  ])("%s is a usage error (exit 2)", async (_name, argv) => {
    h = await createHarness();
    expect(await main(argv, h.deps)).toBe(EXIT_CODES.usage);
  });

  it("global --store and --json are visible to subcommands via optsWithGlobals", async () => {
    h = await createHarness();
    let seen: Record<string, unknown> | undefined;
    const program = buildProgram(h.deps);
    const inspect = program.commands.find((c) => c.name() === "inspect");
    inspect?.action((_id: string, _o: unknown, cmd: Command) => {
      seen = cmd.optsWithGlobals();
    });
    await program.parseAsync(["--store", "S", "inspect", "abc", "--json"], { from: "user" });
    expect(seen).toMatchObject({ store: "S", json: true });
  });

  it("an unimplemented stub surfaces a fixed CliError message and exit 1", async () => {
    h = await createHarness();
    expect(await main(["run", "abc"], h.deps)).toBe(EXIT_CODES.internal);
    expect(h.stderr.join("")).toBe("stint: Not implemented.\n");
  });

  it("under --json a CliError is emitted as {error,code} on stdout", async () => {
    h = await createHarness();
    expect(await main(["run", "abc", "--json"], h.deps)).toBe(EXIT_CODES.internal);
    expect(JSON.parse(h.stdout.join(""))).toEqual({ error: "Not implemented.", code: 1 });
  });
});
