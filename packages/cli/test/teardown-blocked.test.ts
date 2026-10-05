/**
 * Plan 08-10 blocked teardown (TEAR-07, D-11, D-12, D-27): a `cleanup` whose recorded
 * credentials are unavailable exits 2 with a fixed message, runs no step, changes no
 * state and leaves exactly one `teardown_blocked` receipt; the only way forward is to
 * run it again with a credentials file that covers the missing resources.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { blockedTeardownMessage } from "../src/messages.js";
import { main } from "../src/program.js";
import { ACCESS_TOKEN, ORDERS } from "./helpers/run-fixture.js";
import { createTeardownRig, stepRecorder } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

async function setupRevoked(): Promise<TeardownRig> {
  rig = await createTeardownRig();
  await rig.setLease({ state: "revoked" });
  return rig;
}

async function blockedEntries(r: TeardownRig): Promise<Array<Record<string, unknown>>> {
  const entries: readonly { payload: unknown }[] = await r.entries("teardown_blocked");
  return entries.map((e) => e.payload as Record<string, unknown>);
}

describe("blocked cleanup", () => {
  it("exits 2 naming the resource and the recovery command, runs no step, changes no state, receipts once", async () => {
    const r = await setupRevoked();
    const spy = stepRecorder();
    const deps = r.withDeps({ teardown: { decorateSteps: spy.decorateSteps } });

    const code = await main(r.argv("cleanup", "--yes"), deps);

    expect(code).toBe(EXIT_CODES.usage);
    const stderr = r.fx.harness.stderr.join("");
    expect(stderr).toContain("Teardown is blocked");
    expect(stderr).toContain(ORDERS);
    expect(stderr).toContain(`stint-cli cleanup ${r.leaseId} --credentials <file>`);
    expect(spy.ran).toEqual([]);
    expect((await r.lease()).state).toBe("revoked");
    expect(await blockedEntries(r)).toEqual([
      { reason: "credentials_unavailable", resources: [ORDERS] },
    ]);
    expect(r.fx.harness.allOutput()).not.toContain(ACCESS_TOKEN);
  });

  it("the same command a second time still exits 2 and adds no second receipt", async () => {
    const r = await setupRevoked();
    expect(await main(r.argv("cleanup", "--yes"), r.deps)).toBe(EXIT_CODES.usage);
    expect(await main(r.argv("cleanup", "--yes"), r.deps)).toBe(EXIT_CODES.usage);

    expect(await blockedEntries(r)).toHaveLength(1);
    expect((await r.lease()).state).toBe("revoked");
  });

  it("an empty credentials file is blocked the same way, never cleaned_up", async () => {
    const r = await setupRevoked();
    const empty = path.join(r.root, "empty-credentials.json");
    await writeFile(empty, "{}");

    const code = await main(r.argv("cleanup", "--yes", "--credentials", empty), r.deps);

    expect(code).toBe(EXIT_CODES.usage);
    expect(r.fx.harness.stderr.join("")).toContain("Teardown is blocked");
    expect((await r.lease()).state).toBe("revoked");
    expect(await blockedEntries(r)).toHaveLength(1);
  });

  it("re-running with a file that covers the missing resources reaches cleaned_up (the only recovery)", async () => {
    const r = await setupRevoked();
    expect(await main(r.argv("cleanup", "--yes"), r.deps)).toBe(EXIT_CODES.usage);
    r.clearOutput();

    const code = await main(
      r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath),
      r.deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
  });

  it("under --json a blocked cleanup prints one object with code 2 and the same message", async () => {
    const r = await setupRevoked();
    const code = await main(["--store", r.root, "--json", "cleanup", r.leaseId, "--yes"], r.deps);

    expect(code).toBe(EXIT_CODES.usage);
    const stdout = r.fx.harness.stdout.join("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      code: 2,
      error: blockedTeardownMessage(r.leaseId, [ORDERS]),
    });
  });

  it("revoke with no credentials refuses with exit 2 before any state change and writes no receipt", async () => {
    rig = await createTeardownRig();
    const code = await main(rig.argv("revoke", "--yes"), rig.deps);

    expect(code).toBe(EXIT_CODES.usage);
    expect((await rig.lease()).state).toBe("active");
    expect(await rig.entries("teardown_blocked")).toHaveLength(0);
    expect(await rig.entries("transition")).toHaveLength(0);
    expect(rig.fx.harness.stderr.join("")).toContain("--credentials");
  });

  it("has no abandon, force or skip option on cleanup", async () => {
    const program = await readFile(new URL("../src/program.ts", import.meta.url), "utf8");
    expect(program).not.toMatch(/--(abandon|force|skip)/);
  });
});
