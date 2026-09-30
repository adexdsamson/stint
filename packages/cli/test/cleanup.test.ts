import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import {
  NOW,
  createTeardownRig,
  scriptedConfirm,
  startRevocable,
  stepRecorder,
} from "./helpers/teardown-rig.js";
import type { Revocable, TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
let as: Revocable | undefined;
afterEach(async () => {
  await as?.close();
  as = undefined;
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

async function setup(): Promise<{ rig: TeardownRig; as: Revocable }> {
  rig = await createTeardownRig();
  as = await startRevocable(rig);
  return { rig, as };
}

function payloads(entries: readonly { payload: unknown }[]): Array<Record<string, unknown>> {
  return entries.map((e) => e.payload as Record<string, unknown>);
}

describe("stint cleanup", () => {
  it.each(["completed", "expired", "revoked", "failed"] as const)(
    "a %s lease runs teardown to cleaned_up (exit 0), auto-chaining begin_teardown",
    async (state) => {
      const { rig, as } = await setup();
      await rig.setLease({ state });
      const code = await main(rig.argv("cleanup", "--yes", "--credentials", as.creds), as.deps());

      expect(code).toBe(EXIT_CODES.ok);
      expect((await rig.lease()).state).toBe("cleaned_up");
      expect(payloads(await rig.entries("transition")).map((t) => t.event)).toEqual([
        "begin_teardown",
        "teardown_succeeded",
      ]);
      expect(rig.fx.harness.stdout.join("")).toContain("cleaned_up");
      expect(rig.fx.harness.stderr.join("")).toContain(`stint-cli verify ${rig.leaseId}`);
    },
  );

  it("a tearing_down lease is resumed with runTeardown, skipping nothing it has not recorded", async () => {
    const { rig, as } = await setup();
    await rig.setLease({ state: "tearing_down" });
    const spy = stepRecorder();
    const code = await main(
      rig.argv("cleanup", "--yes", "--credentials", as.creds),
      as.deps({ decorateSteps: spy.decorateSteps }),
    );
    expect(code).toBe(EXIT_CODES.ok);
    expect(spy.ran).toHaveLength(5);
    expect((await rig.lease()).state).toBe("cleaned_up");
  });

  it("cleanup_incomplete resumes via retryTeardown without re-running succeeded steps or reactivating", async () => {
    rig = await createTeardownRig();
    // Steps 1 and 2 already recorded a success; the rest are still owed. No credentials are
    // needed: revoke_oauth was attempted once and is never re-run.
    await rig.setLease({
      state: "cleanup_incomplete",
      teardownProgress: { revoke_oauth: "revoked", invalidate_license: "ok" },
    });
    const spy = stepRecorder();
    const code = await main(
      rig.argv("cleanup", "--yes"),
      rig.withDeps({ teardown: { decorateSteps: spy.decorateSteps } }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect(spy.ran).toEqual(["cleanup_hook", "delete_cached_data", "final_receipt"]);
    const lease = await rig.lease();
    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress?.revoke_oauth).toBe("revoked");
    expect(lease.teardownProgress?.invalidate_license).toBe("ok");

    const trail = payloads(await rig.entries("transition"));
    expect(trail.map((t) => t.event)).toEqual(["retry_teardown", "teardown_succeeded"]);
    expect(trail.find((t) => t.event === "retry_teardown")).toMatchObject({ actor: "user" });
    expect(trail.some((t) => t.to === "active")).toBe(false);
  });

  it("a second forced failure leaves cleanup_incomplete (exit 7) with the earlier outcome untouched", async () => {
    rig = await createTeardownRig();
    await rig.setLease({
      state: "cleanup_incomplete",
      teardownProgress: {
        revoke_oauth: "revoked",
        invalidate_license: "ok",
        cleanup_hook: "failed",
      },
    });
    const spy = stepRecorder("cleanup_hook");
    const code = await main(
      rig.argv("cleanup", "--yes"),
      rig.withDeps({ teardown: { decorateSteps: spy.decorateSteps } }),
    );

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    const lease = await rig.lease();
    expect(lease.state).toBe("cleanup_incomplete");
    expect(lease.teardownProgress?.revoke_oauth).toBe("revoked");
    expect(lease.teardownProgress?.cleanup_hook).toBe("failed");
    // A recorded failure for steps 2-5 re-runs; a recorded success does not.
    expect(spy.ran).toEqual(["cleanup_hook", "delete_cached_data", "final_receipt"]);
    expect(rig.fx.harness.stderr.join("")).toContain(`stint-cli cleanup ${rig.leaseId}`);
  });

  it("a cleaned_up lease is an idempotent no-op success that touches nothing", async () => {
    rig = await createTeardownRig();
    await rig.setLease({ state: "cleaned_up" });
    const before = await rig.lease();
    const spy = stepRecorder();
    const code = await main(
      rig.argv("cleanup"),
      rig.withDeps({ teardown: { decorateSteps: spy.decorateSteps } }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect(spy.ran).toEqual([]);
    expect(await rig.lease()).toEqual(before);
    expect(await rig.entries("transition")).toHaveLength(0);
    expect(await rig.entries("teardown_step")).toHaveLength(0);
  });

  it("an active, non-expired lease is refused with wrongState (9): use revoke", async () => {
    rig = await createTeardownRig();
    const code = await main(rig.argv("cleanup", "--yes"), rig.deps);
    expect(code).toBe(EXIT_CODES.wrongState);
    expect(rig.fx.harness.stderr.join("")).toContain("use revoke");
    expect((await rig.lease()).state).toBe("active");
  });

  it.each(["proposed", "declined"] as const)(
    "a %s lease is refused with wrongState (9)",
    async (state) => {
      rig = await createTeardownRig();
      await rig.setLease({ state });
      expect(await main(rig.argv("cleanup", "--yes"), rig.deps)).toBe(EXIT_CODES.wrongState);
      expect((await rig.lease()).state).toBe(state);
    },
  );

  it("an active lease past expiresAt is lazily settled as expired, then torn down (A9)", async () => {
    const { rig, as } = await setup();
    const lease = await rig.lease();
    expect(lease.expiresAt).toBeGreaterThan(NOW);

    const code = await main(
      rig.argv("cleanup", "--yes", "--credentials", as.creds),
      as.deps({}, { clock: () => lease.expiresAt + 1 }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await rig.lease()).state).toBe("cleaned_up");
    const trail = payloads(await rig.entries("transition"));
    expect(trail.map((t) => t.event)).toEqual(["expire", "begin_teardown", "teardown_succeeded"]);
    expect(trail[0]).toMatchObject({ from: "active", to: "expired", actor: "clock" });
  });

  it("prompts [y/N] unless --yes: 'n' changes nothing (3), no terminal refuses (2)", async () => {
    const { rig, as } = await setup();
    await rig.setLease({ state: "revoked" });
    const before = await rig.lease();

    const no = scriptedConfirm(false);
    expect(
      await main(
        rig.argv("cleanup", "--credentials", as.creds),
        as.deps({}, { confirm: no.confirm }),
      ),
    ).toBe(EXIT_CODES.consentDeclined);
    expect(no.asked).toEqual(["Run teardown for this lease? [y/N] "]);
    expect(await rig.lease()).toEqual(before);

    expect(await main(rig.argv("cleanup", "--credentials", as.creds), as.deps())).toBe(
      EXIT_CODES.usage,
    );
    expect(await rig.lease()).toEqual(before);

    const yes = scriptedConfirm(true);
    expect(
      await main(
        rig.argv("cleanup", "--credentials", as.creds),
        as.deps({}, { confirm: yes.confirm }),
      ),
    ).toBe(EXIT_CODES.ok);
  });

  it("asks the retry question for cleanup_incomplete", async () => {
    rig = await createTeardownRig();
    await rig.setLease({
      state: "cleanup_incomplete",
      teardownProgress: { revoke_oauth: "revoked" },
    });
    const ask = scriptedConfirm(false);
    await main(rig.argv("cleanup"), rig.withDeps({ confirm: ask.confirm }));
    expect(ask.asked).toEqual(["Retry teardown for this lease? [y/N] "]);
  });

  it("a delegated lease whose revoke_oauth has not run needs --credentials (2), lease untouched", async () => {
    rig = await createTeardownRig();
    await rig.setLease({ state: "revoked" });
    expect(await main(rig.argv("cleanup", "--yes"), rig.deps)).toBe(EXIT_CODES.usage);
    expect((await rig.lease()).state).toBe("revoked");
  });

  it("unknown lease exits 4", async () => {
    rig = await createTeardownRig();
    expect(await main(["--store", rig.root, "cleanup", "nope", "--yes"], rig.deps)).toBe(
      EXIT_CODES.leaseNotFound,
    );
  });
});
