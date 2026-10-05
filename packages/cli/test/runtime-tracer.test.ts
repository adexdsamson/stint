/**
 * Phase 8 tracer (08-01): `stint-cli cleanup` on an expired lease whose credential has no
 * revocation endpoint settles the lease through `@stint/runtime`, lands `cleaned_up` with exit 0,
 * and leaves a schema-valid receipt chain that names the credential.
 */

import { verifyChain } from "@stint/core";
import type { TelemetryEvent } from "@stint/core";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

function payloads(entries: readonly { payload: unknown }[]): Array<Record<string, unknown>> {
  return entries.map((e) => e.payload as Record<string, unknown>);
}

function recordingTelemetry(): { readonly events: TelemetryEvent[]; readonly emit: (e: TelemetryEvent) => void } {
  const events: TelemetryEvent[] = [];
  return { events, emit: (e) => void events.push(e) };
}

describe("runtime tracer: expired lease, unrevocable credential", () => {
  it("settles through @stint/runtime and reaches cleaned_up with exit 0", async () => {
    rig = await createTeardownRig();
    const lease = await rig.lease();
    const telemetry = recordingTelemetry();
    const deps = rig.withDeps({ clock: () => lease.expiresAt + 1, telemetry });

    const code = await main(
      rig.argv("cleanup", "--yes", "--credentials", rig.fx.credentialsPath),
      deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    const after = await rig.lease();
    expect(after.state).toBe("cleaned_up");
    expect(after.teardownProgress?.revoke_oauth).toBe("discarded_revocation_unsupported");

    const trail = payloads(await rig.entries("transition"));
    expect(trail.map((t) => t.event)).toEqual(["expire", "begin_teardown", "teardown_succeeded"]);

    const revokeSteps = payloads(await rig.entries("teardown_step")).filter(
      (s) => s.step === "revoke_oauth",
    );
    expect(revokeSteps).toContainEqual({
      step: "revoke_oauth",
      outcome: "discarded_revocation_unsupported",
      resource: "sheets.orders",
    });

    const chain = await deps.receiptStoreFactory(rig.root, rig.leaseId).load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);

    // Only settleExpired emits this event, so it proves the path ran through the runtime and the core port.
    expect(telemetry.events).toContainEqual({
      name: "lease.transition",
      leaseId: rig.leaseId,
      from: "active",
      to: "expired",
      actor: "clock",
    });
  });

  it("settles when the clock equals expiresAt exactly (adjacency)", async () => {
    rig = await createTeardownRig();
    const lease = await rig.lease();
    const deps = rig.withDeps({ clock: () => lease.expiresAt });

    const code = await main(
      rig.argv("cleanup", "--yes", "--credentials", rig.fx.credentialsPath),
      deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await rig.lease()).state).toBe("cleaned_up");
  });

  it("refuses with wrongState one second before expiresAt and changes nothing", async () => {
    rig = await createTeardownRig();
    const lease = await rig.lease();
    const deps = rig.withDeps({ clock: () => lease.expiresAt - 1 });

    const code = await main(
      rig.argv("cleanup", "--yes", "--credentials", rig.fx.credentialsPath),
      deps,
    );

    expect(code).toBe(EXIT_CODES.wrongState);
    expect((await rig.lease()).state).toBe("active");
    expect(await rig.entries("transition")).toHaveLength(0);
  });
});
