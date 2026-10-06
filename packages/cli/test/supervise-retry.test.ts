/**
 * Phase 9 plan 04: `stint-cli supervise --once` retries a `cleanup_incomplete`
 * lease on a receipt-derived backoff, prints one fixed line per retry and per
 * stuck marking, and validates the three retry flags (SUP-02, D-01, D-04, D-20, D-22).
 */

import type { TeardownStep } from "@stint/proxy";
import { afterEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { ACCESS_TOKEN } from "./helpers/run-fixture.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

/** `cleanup_hook` fails the first `failures` times it runs (`Infinity` for always). */
function flakyHook(failures: number): {
  readonly decorateSteps: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
  readonly hook: { left: number };
} {
  const hook = { left: failures };
  return {
    hook,
    decorateSteps: (steps) =>
      steps.map(
        (step): TeardownStep => ({
          name: step.name,
          run: (lease, now) => {
            if (step.name === "cleanup_hook" && hook.left > 0) {
              hook.left -= 1;
              return Promise.resolve("failed");
            }
            return step.run(lease, now);
          },
        }),
      ),
  };
}

async function setup(failures: number): Promise<{
  readonly rig: TeardownRig;
  readonly landing: number;
  readonly run: (clock: number, flags?: readonly string[], globals?: readonly string[]) => Promise<number>;
}> {
  rig = await createTeardownRig();
  const r = rig;
  const lease = await r.lease();
  await seedFromCredentials(r.deps, buildRuntimePorts(r.deps, r.root), r.leaseId, r.fx.credentials);
  const { decorateSteps } = flakyHook(failures);
  const run = (clock: number, flags: readonly string[] = [], globals: readonly string[] = []): Promise<number> =>
    main(
      ["--store", r.root, ...globals, "supervise", "--once", ...flags],
      r.withDeps({ clock: () => clock, teardown: { decorateSteps } }),
    );
  // The first sweep settles the expired lease and lands it cleanup_incomplete (or cleaned_up with no failure).
  const landing = lease.expiresAt + 1;
  expect(await run(landing)).toBe(EXIT_CODES.ok);
  r.clearOutput();
  return { rig: r, landing, run };
}

const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");
const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");

describe("supervise --once retry (SUP-02)", () => {
  it("prints nothing one second before the backoff ends and retries to cleaned_up at exactly the end", async () => {
    const { rig: r, landing, run } = await setup(1);
    expect((await r.lease()).state).toBe("cleanup_incomplete");
    const before = await r.allReceiptsJson();
    const leaseBefore = await r.lease();

    expect(await run(landing + 59)).toBe(EXIT_CODES.ok);
    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect(await r.lease()).toEqual(leaseBefore);
    expect(await r.allReceiptsJson()).toBe(before);

    expect(await run(landing + 60)).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
    const stderr = stderrOf(r);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} teardown retried (attempt 1): cleaned_up`);
    expect(stderr).toContain("The credential for sheets.orders was not revoked upstream. Rotate it in the provider dashboard.");
    expect(stderr).not.toContain(ACCESS_TOKEN);
    expect(stdoutOf(r)).toBe("");
    const transitions = (await r.entries("transition")).map((e) => (e.payload as { event: string }).event);
    expect(transitions.slice(-2)).toEqual(["retry_teardown", "teardown_succeeded"]);
  });

  it("marks the lease stuck in the same run when --retry-cap 1 is spent, naming the reason and the exact cleanup command", async () => {
    const { rig: r, landing, run } = await setup(Number.POSITIVE_INFINITY);

    expect(await run(landing + 60, ["--retry-cap", "1"])).toBe(EXIT_CODES.cleanupIncomplete);

    expect((await r.lease()).state).toBe("cleanup_incomplete");
    const stderr = stderrOf(r);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} teardown retried (attempt 1): cleanup_incomplete.`);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} is stuck (retries_exhausted).`);
    expect(stderr).toContain(`stint-cli cleanup ${r.leaseId}`);
    expect(stderr).toContain(`stint-cli receipts ${r.leaseId}`);
    expect(stdoutOf(r)).toBe("");
    const stuck = await r.entries("teardown_stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.payload).toEqual({ reason: "retries_exhausted", attempts: 2 });

    // A later run is a new process: it announces the stuck lease again and exit 7 keeps cron alerted,
    // but it retries nothing and adds no receipt: the lease stays cleanup_incomplete.
    r.clearOutput();
    const snapshot = await r.allReceiptsJson();
    expect(await run(landing + 1_000_000, ["--retry-cap", "1"])).toBe(EXIT_CODES.cleanupIncomplete);
    expect(stderrOf(r)).toContain(`stint: Lease ${r.leaseId} is stuck (retries_exhausted).`);
    expect(stderrOf(r)).not.toContain("retried");
    expect(await r.allReceiptsJson()).toBe(snapshot);
  });

  it("shows the stuck marker in stint-cli receipts", async () => {
    const { rig: r, landing, run } = await setup(Number.POSITIVE_INFINITY);
    expect(await run(landing + 60, ["--retry-cap", "1"])).toBe(EXIT_CODES.cleanupIncomplete);
    r.clearOutput();

    expect(await main(["--store", r.root, "receipts", r.leaseId], r.withDeps({}))).toBe(EXIT_CODES.ok);

    expect(stdoutOf(r)).toContain("teardown stuck: retries_exhausted after 2 failed attempts");
    expect(stdoutOf(r)).not.toContain("unrecognized receipt entry");
  });

  it("under --json prints retried and stuck objects with only the listed scalar fields and no human line", async () => {
    const { rig: r, landing, run } = await setup(Number.POSITIVE_INFINITY);

    expect(await run(landing + 60, ["--retry-cap", "1"], ["--json"])).toBe(EXIT_CODES.cleanupIncomplete);

    const lines = stdoutOf(r).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: "retried", leaseId: r.leaseId, attempt: 1, state: "cleanup_incomplete" },
      { event: "stuck", leaseId: r.leaseId, reason: "retries_exhausted", attempts: 2, repeat: false },
    ]);
    expect(stderrOf(r)).toBe("");
  });

  it("under --json prints the retried object with the landed state", async () => {
    const { rig: r, landing, run } = await setup(1);

    expect(await run(landing + 60, [], ["--json"])).toBe(EXIT_CODES.ok);

    const lines = stdoutOf(r).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: "retried", leaseId: r.leaseId, attempt: 1, state: "cleaned_up" },
    ]);
    expect(stderrOf(r)).toBe("");
  });

  it("honours --retry-base: a 5 second base is due at exactly 5 seconds and not before", async () => {
    const { rig: r, landing, run } = await setup(1);
    expect(await run(landing + 4, ["--retry-base", "5", "--retry-max", "10"])).toBe(EXIT_CODES.ok);
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("cleanup_incomplete");

    expect(await run(landing + 5, ["--retry-base", "5", "--retry-max", "10"])).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
  });
});

describe("supervise retry flag validation", () => {
  const cases: readonly { readonly name: string; readonly flags: readonly string[]; readonly message: string }[] = [
    { name: "--retry-base 0", flags: ["--retry-base", "0"], message: "--retry-base must be a whole number of seconds from 1 to 2147483." },
    { name: "--retry-base 1.5", flags: ["--retry-base", "1.5"], message: "--retry-base must be a whole number of seconds from 1 to 2147483." },
    { name: "--retry-base abc", flags: ["--retry-base", "abc"], message: "--retry-base must be a whole number of seconds from 1 to 2147483." },
    { name: "--retry-base 2147484", flags: ["--retry-base", "2147484"], message: "--retry-base must be a whole number of seconds from 1 to 2147483." },
    { name: "--retry-cap 0", flags: ["--retry-cap", "0"], message: "--retry-cap must be a whole number of retries from 1 to 1000." },
    {
      name: "--retry-max smaller than --retry-base",
      flags: ["--retry-base", "100", "--retry-max", "50"],
      message: "--retry-max must not be smaller than --retry-base.",
    },
  ];

  it.each(cases)("exits 2 with a fixed message for $name and changes nothing", async ({ flags, message }) => {
    rig = await createTeardownRig();
    const r = rig;
    const lease = await r.lease();
    r.clearOutput();
    const before = await r.allReceiptsJson();

    const code = await main(
      ["--store", r.root, "supervise", "--once", ...flags],
      r.withDeps({ clock: () => lease.expiresAt + 1 }),
    );

    expect(code).toBe(EXIT_CODES.usage);
    expect(stderrOf(r)).toBe(`stint: ${message}\n`);
    expect(stdoutOf(r)).toBe("");
    expect((await r.lease()).state).toBe("active");
    expect(await r.allReceiptsJson()).toBe(before);
  });

  it("rejects a --retry-max smaller than the default base when --retry-base is absent", async () => {
    rig = await createTeardownRig();
    const r = rig;
    const lease = await r.lease();
    r.clearOutput();

    const code = await main(
      ["--store", r.root, "supervise", "--once", "--retry-max", "30"],
      r.withDeps({ clock: () => lease.expiresAt + 1 }),
    );

    expect(code).toBe(EXIT_CODES.usage);
    expect(stderrOf(r)).toBe("stint: --retry-max must not be smaller than --retry-base.\n");
  });

  it("rejects out-of-range --retry-max and --retry-cap values and a signed value", async () => {
    rig = await createTeardownRig();
    const r = rig;
    const lease = await r.lease();
    for (const flags of [["--retry-max", "0"], ["--retry-max", "2147484"], ["--retry-cap", "1001"], ["--retry-cap", "-1"]]) {
      r.clearOutput();
      const code = await main(
        ["--store", r.root, "supervise", "--once", ...flags],
        r.withDeps({ clock: () => lease.expiresAt + 1 }),
      );
      expect(code, flags.join(" ")).toBe(EXIT_CODES.usage);
    }
  });
});
