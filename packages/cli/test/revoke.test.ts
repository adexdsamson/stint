import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { appendEntry } from "@stint/core";
import type { TeardownStep } from "@stint/proxy";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { envelopeFile } from "../src/store/envelope.js";
import { NOW } from "./helpers/cli-harness.js";
import { ACCESS_TOKEN } from "./helpers/run-fixture.js";
import {
  createTeardownRig,
  scriptedConfirm,
  startRevocable,
  stepRecorder,
  writeCredentials,
} from "./helpers/teardown-rig.js";
import type { Revocable, TeardownRig } from "./helpers/teardown-rig.js";

const REFRESH_TOKEN = "refresh-token-secret-do-not-leak";

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

describe("stint revoke", () => {
  it("--yes: a user-actor revoke auto-chains teardown to cleaned_up, exit 0, receipted", async () => {
    const { rig, as } = await setup();
    const code = await main(rig.argv("revoke", "--yes", "--credentials", as.creds), as.deps());

    expect(code).toBe(EXIT_CODES.ok);
    expect((await rig.lease()).state).toBe("cleaned_up");

    const trail = payloads(await rig.entries("transition"));
    expect(trail.find((t) => t.event === "revoke")).toMatchObject({
      from: "active",
      to: "revoked",
      actor: "user",
    });
    expect(trail.map((t) => t.event)).toEqual(["revoke", "begin_teardown", "teardown_succeeded"]);
    expect(trail.some((t) => t.actor === "agent")).toBe(false);

    const steps = payloads(await rig.entries("teardown_step")).map((s) => s.step);
    expect(steps).toEqual(
      expect.arrayContaining([
        "revoke_oauth",
        "cleanup_hook",
        "delete_cached_data",
        "final_receipt",
      ]),
    );
    expect(rig.fx.harness.stdout.join("")).toContain("cleaned_up");
    expect(rig.fx.harness.stderr.join("")).toContain(`stint-cli receipts ${rig.leaseId}`);

    // The AS really was asked to revoke (RFC 7009), and the outcome is receipted as such.
    expect(as.requests).toHaveLength(1);
    expect(as.requests[0]).toContain(REFRESH_TOKEN);
    expect((await rig.lease()).teardownProgress?.revoke_oauth).toBe("revoked");
  });

  it("without a revocation endpoint the lease still reaches cleaned_up and is receipted as not revoked upstream", async () => {
    rig = await createTeardownRig();
    // No revocation endpoint in the credentials: the vault can only discard its own copy. SPEC-07
    // counts that as terminal success with a caveat, so the lease lands cleaned_up (exit 0) while the
    // receipt stays honest that nothing was revoked upstream and names the credential.
    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath),
      rig.deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    const lease = await rig.lease();
    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress?.revoke_oauth).toBe("discarded_revocation_unsupported");
    const revokeSteps = payloads(await rig.entries("teardown_step")).filter(
      (s) => s.step === "revoke_oauth",
    );
    const outcomes = revokeSteps.map((s) => s.outcome);
    expect(outcomes).not.toContain("revoked");
    expect(outcomes).toContain("discarded_revocation_unsupported");
    expect(revokeSteps).toContainEqual({
      step: "revoke_oauth",
      outcome: "discarded_revocation_unsupported",
      resource: "sheets.orders",
    });
  });

  it("an unreachable revocation endpoint is receipted 'failed' and yields cleanup_incomplete (7)", async () => {
    rig = await createTeardownRig();
    const creds = await writeCredentials(rig, {
      clientId: "stint-test-client",
      revocationEndpoint: "https://127.0.0.1:1/revoke",
    });
    const code = await main(rig.argv("revoke", "--yes", "--credentials", creds), rig.deps);

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    const lease = await rig.lease();
    expect(lease.state).toBe("cleanup_incomplete");
    expect(lease.teardownProgress?.revoke_oauth).toBe("failed");
    expect(rig.fx.harness.stderr.join("")).toContain(`stint-cli cleanup ${rig.leaseId}`);
  });

  it("'y' at the prompt revokes", async () => {
    const { rig, as } = await setup();
    const ask = scriptedConfirm(true);
    const code = await main(
      rig.argv("revoke", "--credentials", as.creds),
      as.deps({}, { confirm: ask.confirm }),
    );
    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.asked).toEqual(["Revoke this lease? [y/N] "]);
    expect((await rig.lease()).state).toBe("cleaned_up");
  });

  it("'n' at the prompt changes nothing and exits non-zero without receipts", async () => {
    rig = await createTeardownRig();
    const before = await rig.lease();
    const code = await main(
      rig.argv("revoke", "--credentials", rig.fx.credentialsPath),
      rig.withDeps({ confirm: scriptedConfirm(false).confirm }),
    );
    expect(code).toBe(EXIT_CODES.consentDeclined);
    expect(await rig.lease()).toEqual(before);
    expect(await rig.entries("transition")).toHaveLength(0);
    expect(rig.fx.harness.stderr.join("")).toContain("Aborted");
  });

  it("no terminal and no --yes refuses (usage) and leaves the lease active", async () => {
    rig = await createTeardownRig();
    expect(await main(rig.argv("revoke", "--credentials", rig.fx.credentialsPath), rig.deps)).toBe(
      EXIT_CODES.usage,
    );
    expect((await rig.lease()).state).toBe("active");

    const noTty = scriptedConfirm(undefined);
    expect(
      await main(
        rig.argv("revoke", "--credentials", rig.fx.credentialsPath),
        rig.withDeps({ confirm: noTty.confirm }),
      ),
    ).toBe(EXIT_CODES.usage);
    expect((await rig.lease()).state).toBe("active");
  });

  it("a delegated lease without --credentials is refused before any state change", async () => {
    rig = await createTeardownRig();
    expect(await main(rig.argv("revoke", "--yes"), rig.deps)).toBe(EXIT_CODES.usage);
    expect((await rig.lease()).state).toBe("active");
    expect(rig.fx.harness.stderr.join("")).toContain("--credentials");
  });

  it("a fault-injected teardown step lands cleanup_incomplete with exit 7", async () => {
    const { rig, as } = await setup();
    const faults = stepRecorder("cleanup_hook");
    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", as.creds),
      as.deps({ decorateSteps: faults.decorateSteps }),
    );

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    const lease = await rig.lease();
    expect(lease.state).toBe("cleanup_incomplete");
    // A failure never aborts the walk: every step still ran, in the fixed order.
    expect(faults.ran).toEqual([
      "revoke_oauth",
      "invalidate_license",
      "cleanup_hook",
      "delete_cached_data",
      "final_receipt",
    ]);
    expect(lease.teardownProgress?.cleanup_hook).toBe("failed");
    expect(rig.fx.harness.stdout.join("")).toContain("cleanup_incomplete");
  });

  it.each(["proposed", "completed", "cleaned_up"] as const)(
    "revoke from %s is refused with wrongState (9) and changes nothing",
    async (state) => {
      rig = await createTeardownRig();
      await rig.setLease({ state });
      const before = await rig.lease();
      const code = await main(
        rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath),
        rig.deps,
      );
      expect(code).toBe(EXIT_CODES.wrongState);
      expect(await rig.lease()).toEqual(before);
      expect(await rig.entries("transition")).toHaveLength(0);
    },
  );

  it("an unknown lease exits 4; a lease without a stored manifest exits 5", async () => {
    rig = await createTeardownRig();
    expect(await main(["--store", rig.root, "revoke", "no-such-lease", "--yes"], rig.deps)).toBe(
      EXIT_CODES.leaseNotFound,
    );

    await rm(envelopeFile(rig.root, rig.leaseId));
    expect(
      await main(rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath), rig.deps),
    ).toBe(EXIT_CODES.manifestInvalid);
    expect((await rig.lease()).state).toBe("active");
  });

  it("never persists or prints credential material", async () => {
    const { rig, as } = await setup();
    await main(rig.argv("revoke", "--yes", "--credentials", as.creds), as.deps());

    const stored = JSON.stringify(await rig.lease()) + (await rig.allReceiptsJson());
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN]) {
      expect(stored).not.toContain(secret);
      expect(rig.fx.harness.allOutput()).not.toContain(secret);
    }
  });

  it("--json prints one machine-readable result on stdout", async () => {
    const { rig, as } = await setup();
    const code = await main(
      ["--json", ...rig.argv("revoke", "--yes", "--credentials", as.creds)],
      as.deps(),
    );
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(rig.fx.harness.stdout.join(""))).toMatchObject({
      leaseId: rig.leaseId,
      state: "cleaned_up",
    });
  });
});

type RevokeOutcome = "revoked" | "discarded_revocation_unsupported" | "failed";

/**
 * Replaces `revoke_oauth` so it writes one per-credential receipt per entry (as the real step does) and
 * returns the aggregate. The real vault holds a single OAuth client, so mixed per-credential outcomes
 * cannot be produced from a credentials file; this seam drives the CLI's reporting with them instead.
 */
function mixedRevokeOauth(
  rig: TeardownRig,
  perCredential: ReadonlyArray<readonly [resource: string, outcome: RevokeOutcome]>,
): (steps: readonly TeardownStep[]) => readonly TeardownStep[] {
  const receipts = rig.fx.harness.deps.receiptStoreFactory(rig.root, rig.leaseId);
  return (steps) =>
    steps.map((step): TeardownStep => {
      if (step.name !== "revoke_oauth") return step;
      return {
        name: step.name,
        run: async () => {
          for (const [resource, outcome] of perCredential) {
            const chain = await receipts.load("verified");
            const entry = appendEntry(
              chain,
              {
                chain: "verified",
                type: "teardown_step",
                payload: { step: "revoke_oauth", outcome, resource },
              },
              NOW,
            );
            await receipts.append("verified", entry);
          }
          const outcomes = perCredential.map(([, outcome]) => outcome);
          if (outcomes.includes("failed")) return "failed";
          if (outcomes.every((o) => o === "revoked")) return "revoked";
          return "discarded_revocation_unsupported";
        },
      };
    });
}

describe("stint revoke: SPEC-07 caveat", () => {
  it("an unrevocable credential exits 0, labels the state and names the credential on stderr", async () => {
    rig = await createTeardownRig();
    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath),
      rig.deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect(rig.fx.harness.stdout.join("")).toContain(
      "cleaned_up (credential not revoked upstream)",
    );
    const err = rig.fx.harness.stderr.join("");
    expect(err).toContain("was not revoked upstream. Rotate it in the provider dashboard.");
    expect(err).toContain("sheets.orders");
    // The stored state stays the plain value; only the display carries the label.
    expect((await rig.lease()).state).toBe("cleaned_up");
  });

  it("--json keeps the plain state and lists the unrevoked resources", async () => {
    rig = await createTeardownRig();
    const code = await main(
      ["--json", ...rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath)],
      rig.deps,
    );
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(rig.fx.harness.stdout.join(""))).toMatchObject({
      state: "cleaned_up",
      unrevoked: ["sheets.orders"],
    });
  });

  it("a revocable credential prints the plain state and no caveat", async () => {
    const { rig, as } = await setup();
    const code = await main(rig.argv("revoke", "--yes", "--credentials", as.creds), as.deps());

    expect(code).toBe(EXIT_CODES.ok);
    const out = rig.fx.harness.stdout.join("");
    expect(out).toContain("cleaned_up");
    expect(out).not.toContain("not revoked upstream");
    expect(rig.fx.harness.stderr.join("")).not.toContain("not revoked upstream");
  });

  it("revoked plus unsupported reaches cleaned_up and the caveat names only the unsupported one", async () => {
    rig = await createTeardownRig();
    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath),
      rig.withDeps({
        teardown: {
          decorateSteps: mixedRevokeOauth(rig, [
            ["sheets.orders", "revoked"],
            ["docs.notes", "discarded_revocation_unsupported"],
          ]),
        },
      }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await rig.lease()).state).toBe("cleaned_up");
    expect(rig.fx.harness.stdout.join("")).toContain(
      "cleaned_up (credential not revoked upstream)",
    );
    const err = rig.fx.harness.stderr.join("");
    expect(err).toContain("The credential for docs.notes was not revoked upstream.");
    expect(err).not.toContain("sheets.orders");
  });

  it("failed plus unsupported stays cleanup_incomplete (7) with no label suffix", async () => {
    rig = await createTeardownRig();
    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath),
      rig.withDeps({
        teardown: {
          decorateSteps: mixedRevokeOauth(rig, [
            ["sheets.orders", "failed"],
            ["docs.notes", "discarded_revocation_unsupported"],
          ]),
        },
      }),
    );

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    expect((await rig.lease()).state).toBe("cleanup_incomplete");
    expect(rig.fx.harness.stdout.join("")).not.toContain("not revoked upstream");
    expect(rig.fx.harness.stderr.join("")).toContain(`stint-cli cleanup ${rig.leaseId}`);
  });
});
