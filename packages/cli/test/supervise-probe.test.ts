/**
 * Phase 9 plan 07: `supervise --once` probes an idle active lease's grant at the
 * provider and ends the lease when the provider revoked it (SUP-04, D-14 to D-17,
 * D-20). `--probe-interval` sets the interval or disables probing. A provider
 * failure that is not a definitive revocation prints nothing and ends nothing.
 */

import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import { EXIT_CODES } from "../src/exit.js";
import { sweepGrantRevokedLine } from "../src/messages.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { CREDENTIALS_JSON, ORDERS } from "./helpers/run-fixture.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
let mock: MockAuthHarness;

beforeEach(async () => {
  mock = await startMockAuthServer();
});

afterEach(async () => {
  await mock.stop();
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");
const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");

/** An active lease whose credential points at the loopback mock token endpoint. */
async function setup(): Promise<{ readonly rig: TeardownRig; readonly grantedAt: number }> {
  rig = await createTeardownRig();
  const lease = await rig.lease();
  expect(lease.state).toBe("active");
  const tokenEndpoint = mock.oauthClient.as.token_endpoint;
  if (tokenEndpoint === undefined) throw new Error("mock has no token endpoint");
  const base = CREDENTIALS_JSON[ORDERS];
  if (base === undefined) throw new Error("fixture has no credential");
  await seedFromCredentials(rig.deps, buildRuntimePorts(rig.deps, rig.root), rig.leaseId, {
    [ORDERS]: { ...base, tokenEndpoint },
  });
  rig.clearOutput();
  return { rig, grantedAt: lease.grantedAt };
}

function supervise(
  r: TeardownRig,
  clock: number,
  flags: readonly string[] = [],
  globals: readonly string[] = [],
): Promise<number> {
  return main(["--store", r.root, ...globals, "supervise", "--once", ...flags], r.withDeps({ clock: () => clock }));
}

describe("supervise --once probes an idle lease (SUP-04)", () => {
  it("prints the grant-revoked line then the torn-down line when the provider revoked the grant, and exits 0", async () => {
    const { rig: r, grantedAt } = await setup();
    mock.forceNextTokenError("invalid_grant");

    expect(await supervise(r, grantedAt + 900)).toBe(EXIT_CODES.ok);

    const stderr = stderrOf(r);
    const revoked = `stint: ${sweepGrantRevokedLine(r.leaseId)}\n`;
    expect(stderr.startsWith(revoked)).toBe(true);
    const tornDown = stderr.indexOf(`stint: Lease ${r.leaseId} teardown finished`);
    expect(tornDown).toBeGreaterThanOrEqual(revoked.length);
    expect(stdoutOf(r)).toBe("");
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(mock.tokenEndpointHits).toBe(1);
  });

  it("does not probe a lease idle for less than the default interval", async () => {
    const { rig: r, grantedAt } = await setup();
    expect(await supervise(r, grantedAt + 899)).toBe(EXIT_CODES.ok);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("active");
  });

  it("--probe-interval 0 sends no token request and prints nothing", async () => {
    const { rig: r, grantedAt } = await setup();
    mock.forceNextTokenError("invalid_grant");
    expect(await supervise(r, grantedAt + 3000, ["--probe-interval", "0"])).toBe(EXIT_CODES.ok);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("active");
  });

  it("--probe-interval 60 probes a lease idle for 60 s", async () => {
    const { rig: r, grantedAt } = await setup();
    expect(await supervise(r, grantedAt + 59, ["--probe-interval", "60"])).toBe(EXIT_CODES.ok);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await supervise(r, grantedAt + 60, ["--probe-interval", "60"])).toBe(EXIT_CODES.ok);
    expect(mock.tokenEndpointHits).toBe(1);
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("active");
  });

  it("a 503 from the token endpoint prints nothing, ends nothing and exits 0", async () => {
    const { rig: r, grantedAt } = await setup();
    mock.forceNextTokenResponse(503, { error: "invalid_grant" });

    expect(await supervise(r, grantedAt + 900)).toBe(EXIT_CODES.ok);

    expect(mock.tokenEndpointHits).toBe(1);
    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("active");
    expect(await r.entries("transition")).toHaveLength(0);
  });

  it("under --json prints the grant_revoked object before the torn_down object", async () => {
    const { rig: r, grantedAt } = await setup();
    mock.forceNextTokenError("invalid_grant");

    expect(await supervise(r, grantedAt + 900, [], ["--json"])).toBe(EXIT_CODES.ok);

    const lines = stdoutOf(r)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.event)).toEqual(["grant_revoked", "torn_down"]);
    expect(lines[0]).toEqual({ event: "grant_revoked", leaseId: r.leaseId });
    expect(lines[1]?.leaseId).toBe(r.leaseId);
    expect(lines[1]?.state).toBe("cleaned_up");
    expect(stderrOf(r)).toBe("");
  });
});

describe("--probe-interval validation", () => {
  it.each([["-1"], ["1.5"], ["2147484"], ["abc"], [""]])(
    "--probe-interval %j exits 2 with a fixed message naming the flag, before any store access",
    async (value) => {
      const { rig: r, grantedAt } = await setup();
      expect(await supervise(r, grantedAt + 900, ["--probe-interval", value])).toBe(EXIT_CODES.usage);
      expect(stderrOf(r)).toBe(
        "stint: --probe-interval must be a whole number of seconds from 0 to 2147483 (0 disables probing).\n",
      );
      expect(mock.tokenEndpointHits).toBe(0);
      expect((await r.lease()).state).toBe("active");
    },
  );

  it("accepts the largest allowed value", async () => {
    const { rig: r, grantedAt } = await setup();
    expect(await supervise(r, grantedAt + 900, ["--probe-interval", "2147483"])).toBe(EXIT_CODES.ok);
    expect(mock.tokenEndpointHits).toBe(0);
  });
});
