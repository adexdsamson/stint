/**
 * Phase 9 plan 09: `stint-cli supervise --once` over the REAL JSON stores keeps
 * sweeping past corrupt data. One corrupt lease record, or one lease whose
 * receipts are torn, is reported once by id and the token `store_corrupt`, never
 * by contents; every other lease is still torn down; the corrupt file is never
 * touched; and `--once` exits 10 so cron can alert (SUP-05, D-23).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Lease } from "@stint/core";
import { afterEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import { EXIT_CODES } from "../src/exit.js";
import { leaseFile } from "../src/paths.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { ACCESS_TOKEN } from "./helpers/run-fixture.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

const MARKER = "CORRUPT-MARKER";
const TORN = `{"torn": "${MARKER}`;

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");
const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");

function supervise(r: TeardownRig, clock: number, flags: readonly string[] = [], globals: readonly string[] = []) {
  return main(
    ["--store", r.root, ...globals, "supervise", "--once", ...flags],
    r.withDeps({ clock: () => clock }),
  );
}

interface Three {
  readonly rig: TeardownRig;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly clock: number;
}

async function stateOf(r: TeardownRig, id: string): Promise<Lease["state"] | undefined> {
  return (await r.deps.storeFactory(r.root).load(id))?.state;
}

/** Three real leases in one store: A, B, C, all `expired`; every lease has credentials seeded (except A when `seedA` is false); the test corrupts one. */
async function setupThree(options: { readonly seedA?: boolean } = {}): Promise<Three> {
  rig = await createTeardownRig();
  const r = rig;
  const ports = buildRuntimePorts(r.deps, r.root);
  const manifestPath = path.join(r.root, "manifest.json");
  const ids = [r.leaseId];
  for (let i = 0; i < 2; i += 1) {
    r.clearOutput();
    const code = await main(["--store", r.root, "create", manifestPath], r.deps);
    if (code !== 0) throw new Error(`create exited ${String(code)}: ${stderrOf(r)}`);
    ids.push(stdoutOf(r).trim());
  }
  const [a, b, c] = ids as [string, string, string];
  const store = r.deps.storeFactory(r.root);
  for (const id of ids) {
    const lease = await store.load(id);
    if (lease === undefined) throw new Error("setup: lease missing");
    await store.save({ ...lease, state: "expired" });
  }
  for (const id of options.seedA === false ? [b, c] : ids) await seedFromCredentials(r.deps, ports, id, r.fx.credentials);
  const lease = await store.load(a);
  r.clearOutput();
  return { rig: r, a, b, c, clock: (lease?.expiresAt ?? 0) + 1 };
}

describe("supervise --once with a corrupt lease record (SUP-05)", () => {
  it("reports one line, tears down the others, leaves the bytes alone and exits 10", async () => {
    const { rig: r, a, b, c, clock } = await setupThree();
    const file = leaseFile(r.root, b);
    await writeFile(file, TORN);
    const before = await readFile(file);

    expect(await supervise(r, clock)).toBe(EXIT_CODES.storeCorrupt);

    expect(await stateOf(r, a)).toBe("cleaned_up");
    expect(await stateOf(r, c)).toBe("cleaned_up");
    const corruptLines = stderrOf(r)
      .split("\n")
      .filter((line) => line.includes("store_corrupt"));
    expect(corruptLines).toHaveLength(1);
    expect(corruptLines[0]).toContain(b);
    expect(r.fx.harness.allOutput()).not.toContain(MARKER);
    expect(r.fx.harness.allOutput()).not.toContain(ACCESS_TOKEN);
    expect(stdoutOf(r)).toBe("");
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it("treats a zero-byte lease.json the same way", async () => {
    const { rig: r, a, b, c, clock } = await setupThree();
    const file = leaseFile(r.root, b);
    await writeFile(file, "");

    expect(await supervise(r, clock)).toBe(EXIT_CODES.storeCorrupt);

    expect(await stateOf(r, a)).toBe("cleaned_up");
    expect(await stateOf(r, c)).toBe("cleaned_up");
    expect(stderrOf(r).split("\n").filter((line) => line.includes(b))).toHaveLength(1);
    expect((await readFile(file)).length).toBe(0);
  });

  it("reports the same record again on a later run (--once keeps no memory) and exits 10 again", async () => {
    const { rig: r, b, clock } = await setupThree();
    await writeFile(leaseFile(r.root, b), TORN);

    expect(await supervise(r, clock)).toBe(EXIT_CODES.storeCorrupt);
    r.clearOutput();
    expect(await supervise(r, clock + 1)).toBe(EXIT_CODES.storeCorrupt);
    expect(stderrOf(r).split("\n").filter((line) => line.includes("store_corrupt"))).toHaveLength(1);
  });

  it("exits 0 with no output when nothing is corrupt", async () => {
    const { rig: r, clock } = await setupThree();
    const code = await supervise(r, clock);
    expect(code).toBe(EXIT_CODES.ok);
  });

  it("under --json prints exactly one corrupt_record object with event and leaseId", async () => {
    const { rig: r, a, b, c, clock } = await setupThree();
    await writeFile(leaseFile(r.root, b), TORN);

    expect(await supervise(r, clock, [], ["--json"])).toBe(EXIT_CODES.storeCorrupt);

    const objects = stdoutOf(r)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(objects.filter((o) => o.event === "corrupt_record")).toEqual([{ event: "corrupt_record", leaseId: b }]);
    expect(objects.filter((o) => o.event === "torn_down").map((o) => o.leaseId).sort()).toEqual([a, c].sort());
    expect(stdoutOf(r)).not.toContain(MARKER);
    expect(stderrOf(r)).toBe("");
  });
});

describe("supervise --once with one lease's receipts torn (SUP-05)", () => {
  it("reports that lease as store_corrupt, still tears down the others, leaves its bytes alone and exits 10", async () => {
    const { rig: r, a, b, c, clock } = await setupThree();
    // C keeps a valid lease.json but its receipt chain is torn.
    const receiptFile = path.join(r.root, "leases", c, "receipts", "verified.json");
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(receiptFile, TORN);
    const before = await readFile(receiptFile);
    const leaseBytes = await readFile(leaseFile(r.root, c));

    expect(await supervise(r, clock)).toBe(EXIT_CODES.storeCorrupt);

    expect(await stateOf(r, a)).toBe("cleaned_up");
    expect(await stateOf(r, b)).toBe("cleaned_up");
    expect(await stateOf(r, c)).toBe("expired");
    const corruptLines = stderrOf(r)
      .split("\n")
      .filter((line) => line.includes("store_corrupt"));
    expect(corruptLines).toHaveLength(1);
    expect(corruptLines[0]).toContain(c);
    expect(r.fx.harness.allOutput()).not.toContain(MARKER);
    expect((await readFile(receiptFile)).equals(before)).toBe(true);
    expect((await readFile(leaseFile(r.root, c))).equals(leaseBytes)).toBe(true);
  });
});

describe("supervise --once with a corrupt and a stuck lease", () => {
  it("exits 10, not 7", async () => {
    // A has no credential in the store: its teardown is blocked and it is marked stuck.
    const { rig: r, a, b, c, clock } = await setupThree({ seedA: false });
    await writeFile(leaseFile(r.root, b), TORN);

    expect(await supervise(r, clock)).toBe(EXIT_CODES.storeCorrupt);

    expect(stderrOf(r)).toContain("store_corrupt");
    expect(stderrOf(r)).toContain("credentials_unavailable");
    expect(await stateOf(r, a)).toBe("expired");
    expect(await stateOf(r, c)).toBe("cleaned_up");
  });
});

describe("--corrupt-repeat validation", () => {
  it.each([["0"], ["1.5"], ["2147484"], ["abc"], [""], ["-1"]])("rejects %j with exit 2 and a fixed message", async (value) => {
    rig = await createTeardownRig();
    const r = rig;
    r.clearOutput();

    expect(await supervise(r, 1, ["--corrupt-repeat", value])).toBe(EXIT_CODES.usage);
    expect(stderrOf(r)).toBe(
      "stint: --corrupt-repeat must be a whole number of seconds from 1 to 2147483.\n",
    );
  });

  it("accepts a whole number inside the range", async () => {
    rig = await createTeardownRig();
    const r = rig;
    r.clearOutput();

    expect(await supervise(r, 1, ["--corrupt-repeat", "2147483"])).toBe(EXIT_CODES.ok);
  });
});
