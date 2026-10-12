/**
 * `stint-cli run` stops cleanly when its lease ends (Phase 9 D-08): after the run has torn the lease
 * down it prints ONE fixed line on stderr, nothing on stdout (the MCP channel), closes the agent
 * connection and exits 0, then says what remains to do (rotate, supply credentials, resume).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { leaseSecretPrefix } from "@stint/core";
import { afterEach, describe, expect, it } from "vitest";

import type { CliDeps } from "../src/deps.js";
import { EXIT_CODES } from "../src/exit.js";
import { blockedTeardownMessage, leaseEndedLine, runTeardownUnfinishedLine } from "../src/messages.js";
import { main } from "../src/program.js";
import { rotateCaveat } from "../src/render/caveat.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { NOW } from "./helpers/cli-harness.js";
import { ORDERS, PROFILE_JSON } from "./helpers/run-fixture.js";
import { createTeardownRig, startRevocable } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const STOP_PREFIX = "stint: Lease ended (";

interface Served {
  readonly rig: TeardownRig;
  readonly clock: { value: number };
  readonly client: Client;
  readonly done: Promise<number>;
  readonly clientClosed: () => boolean;
  readonly deps: CliDeps;
}

/** Starts `stint-cli run` over an in-memory transport with a fast watcher and a clock the test moves. */
async function serve(
  options: {
    /** Builds the credentials file and profile the run is started with; the fixture's own by default. */
    readonly prepare?: (rig: TeardownRig) => Promise<{ readonly credentials: string; readonly profile: string }>;
  } = {},
): Promise<Served> {
  const rig = await createTeardownRig();
  cleanups.push(() => rig.fx.harness.cleanup());
  const files =
    options.prepare === undefined
      ? { credentials: rig.fx.credentialsPath, profile: rig.fx.profilePath }
      : await options.prepare(rig);
  const clock = { value: NOW };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const deps = rig.withDeps({
    clock: () => clock.value,
    run: { openTerminal: () => undefined, createTransport: () => serverTransport, leaseWatchMs: 20 },
  });
  const done = main(
    [
      "--store",
      rig.root,
      "run",
      rig.leaseId,
      "--profile",
      files.profile,
      "--credentials",
      files.credentials,
    ],
    deps,
  );
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  // A command that fails before serving finishes first; report that instead of hanging on the connect.
  const early = await Promise.race([
    done,
    (async (): Promise<undefined> => {
      await client.connect(clientTransport);
      await client.listTools();
      return undefined;
    })(),
  ]);
  if (early !== undefined) throw new Error(`run exited ${String(early)}: ${rig.fx.harness.stderr.join("")}`);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await done.catch(() => undefined);
  });
  return { rig, clock, client, done, clientClosed: () => closed, deps };
}

/** Writes a run profile whose authorization server is `as`: a run revokes through the profile's client. */
async function writeProfile(rig: TeardownRig, as: Record<string, string>): Promise<string> {
  const profile = path.join(rig.root, "profile-custom.json");
  await writeFile(profile, JSON.stringify({ ...PROFILE_JSON, oauth: { ...PROFILE_JSON.oauth, as } }));
  return profile;
}

/** A run whose authorization server is a loopback http one, so the run's vault may revoke upstream. */
async function serveRevocable(): Promise<{ served: Served; revocable: Awaited<ReturnType<typeof startRevocable>> }> {
  let revocable: Awaited<ReturnType<typeof startRevocable>> | undefined;
  const served = await serve({
    prepare: async (rig) => {
      revocable = await startRevocable(rig);
      cleanups.push(() => revocable?.close() ?? Promise.resolve());
      const creds = JSON.parse(await readFile(revocable.creds, "utf8")) as Record<string, { revocationEndpoint: string }>;
      const endpoint = new URL(creds[ORDERS]?.revocationEndpoint ?? "");
      const origin = endpoint.origin;
      const profile = await writeProfile(rig, {
        issuer: origin,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
      });
      return { credentials: revocable.creds, profile };
    },
  });
  if (revocable === undefined) throw new Error("revocable endpoint was not started");
  return { served, revocable };
}

function stderrOf(served: Served): string {
  return served.rig.fx.harness.stderr.join("");
}

function stopLines(served: Served): string[] {
  return stderrOf(served)
    .split("\n")
    .filter((line) => line.startsWith(STOP_PREFIX));
}

describe("stint-cli run stops when its lease expires (D-08, SUP-01)", () => {
  it("tears the lease down, prints one stop line on stderr, writes nothing to stdout, closes the agent connection and exits 0", async () => {
    const served = await serve();
    const lease = await served.rig.lease();

    served.clock.value = lease.expiresAt;
    const code = await served.done;

    expect(code).toBe(EXIT_CODES.ok);
    expect(stopLines(served)).toEqual(["stint: Lease ended (expired); stopping."]);
    expect(served.rig.fx.harness.stdout).toEqual([]);
    expect((await served.rig.lease()).state).toBe("cleaned_up");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(served.clientClosed()).toBe(true);
  });

  it("prints one rotate line per resource after the stop line when the credential cannot be revoked", async () => {
    const served = await serve();
    const lease = await served.rig.lease();

    served.clock.value = lease.expiresAt;
    await served.done;

    const lines = stderrOf(served).split("\n");
    const stopIndex = lines.indexOf("stint: Lease ended (expired); stopping.");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(lines[stopIndex + 1]).toBe(`stint: ${rotateCaveat(ORDERS)}`);
    expect(lines.filter((line) => line === `stint: ${rotateCaveat(ORDERS)}`)).toHaveLength(1);
    expect(served.rig.fx.harness.stdout).toEqual([]);
  });

  it("prints no rotate line when the credential was revoked upstream", async () => {
    const { served, revocable } = await serveRevocable();
    const lease = await served.rig.lease();

    served.clock.value = lease.expiresAt;
    expect(await served.done).toBe(EXIT_CODES.ok);

    expect(stopLines(served)).toEqual(["stint: Lease ended (expired); stopping."]);
    expect(stderrOf(served)).not.toContain("was not revoked upstream");
    expect(revocable.requests).toHaveLength(1);
    expect((await served.rig.lease()).state).toBe("cleaned_up");
  });

  it("prints the resume line after the stop line when teardown does not finish", async () => {
    // The profile's authorization server offers a revocation endpoint that nothing listens on, so
    // revoke_oauth fails and the lease lands cleanup_incomplete.
    const served = await serve({
      prepare: async (rig) => ({
        credentials: rig.fx.credentialsPath,
        profile: await writeProfile(rig, {
          issuer: "https://as.example.test",
          token_endpoint: "https://as.example.test/token",
          revocation_endpoint: "https://127.0.0.1:1/revoke",
        }),
      }),
    });
    const lease = await served.rig.lease();

    served.clock.value = lease.expiresAt;
    expect(await served.done).toBe(EXIT_CODES.ok);

    const lines = stderrOf(served).split("\n");
    const stopIndex = lines.indexOf("stint: Lease ended (expired); stopping.");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(lines[stopIndex + 1]).toBe(`stint: ${runTeardownUnfinishedLine(served.rig.leaseId)}`);
    expect((await served.rig.lease()).state).toBe("cleanup_incomplete");
    expect(served.rig.fx.harness.stdout).toEqual([]);
  });
});

describe("stint-cli run stops when another process revokes the lease (D-06)", () => {
  it("prints the revoked stop line and exits 0", async () => {
    const served = await serve();

    const code = await main(
      served.rig.argv("revoke", "--yes", "--credentials", served.rig.fx.credentialsPath),
      served.rig.deps,
    );
    expect(code).toBe(EXIT_CODES.ok);

    expect(await served.done).toBe(EXIT_CODES.ok);
    expect(stopLines(served)).toEqual(["stint: Lease ended (revoked); stopping."]);
    expect((await served.rig.lease()).state).toBe("cleaned_up");
    expect(served.rig.fx.harness.stdout.join("")).not.toContain("Lease ended");
  });
});

describe("stint-cli run when teardown is blocked", () => {
  it("prints the stop line, then the blocked message naming the cleanup command, and still exits 0", async () => {
    const served = await serve();
    const lease = await served.rig.lease();
    const ports = buildRuntimePorts(served.rig.deps, served.rig.root);
    await ports.secrets.deletePrefix(leaseSecretPrefix(served.rig.leaseId));

    served.clock.value = lease.expiresAt;
    const code = await served.done;

    expect(code).toBe(EXIT_CODES.ok);
    const lines = stderrOf(served).split("\n");
    const stopIndex = lines.indexOf("stint: Lease ended (expired); stopping.");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(lines[stopIndex + 1]).toBe(`stint: ${blockedTeardownMessage(served.rig.leaseId, [ORDERS])}`);
    expect(served.rig.fx.harness.stdout).toEqual([]);
    expect((await served.rig.lease()).state).toBe("expired");
  });
});

describe("stint-cli run when the agent disconnects first", () => {
  it("exits 0 with no stop line, as before", async () => {
    const served = await serve();

    await served.client.close();

    expect(await served.done).toBe(EXIT_CODES.ok);
    expect(stopLines(served)).toEqual([]);
    expect((await served.rig.lease()).state).toBe("active");
  });
});

describe("the fixed lines", () => {
  it("leaseEndedLine names only the closed reason", () => {
    expect(leaseEndedLine("expired")).toBe("Lease ended (expired); stopping.");
    expect(leaseEndedLine("revoked")).toBe("Lease ended (revoked); stopping.");
    expect(leaseEndedLine("unavailable")).toBe("Lease ended (unavailable); stopping.");
  });

  it("runTeardownUnfinishedLine is the resume wording revoke and cleanup already print", () => {
    expect(runTeardownUnfinishedLine("lease-1")).toBe(
      'Teardown did not finish. Run "stint-cli cleanup lease-1" to resume it.',
    );
  });
});
