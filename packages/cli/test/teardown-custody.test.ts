/**
 * Plan 08-10 custody: credentials passed to `revoke`/`cleanup` are copied into the
 * SecretStore (put-if-absent) with one non-suppressible stderr warning, teardown reads
 * the store rather than the file, and the lease's secrets directory is purged once the
 * lease is `cleaned_up` (D-06, D-08, D-09, D-10, D-13).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { credentialSecretKey } from "@stint/core";
import { parseStoredCredential, serializeStoredCredential } from "@stint/proxy";
import { afterEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import { EXIT_CODES } from "../src/exit.js";
import { PLAINTEXT_WARNING, PLAINTEXT_WARNING_WINDOWS } from "../src/messages.js";
import { leaseSecretsDir } from "../src/paths.js";
import { main } from "../src/program.js";
import type { LoadedCredential } from "../src/run/credentials.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { ACCESS_TOKEN, ORDERS } from "./helpers/run-fixture.js";
import { createTeardownRig, scriptedConfirm, startRevocable } from "./helpers/teardown-rig.js";
import type { Revocable, TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
let as: Revocable | undefined;
afterEach(async () => {
  await as?.close();
  as = undefined;
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

function warningLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.includes(PLAINTEXT_WARNING));
}

async function setupEnded(): Promise<TeardownRig> {
  rig = await createTeardownRig();
  await rig.setLease({ state: "revoked" });
  return rig;
}

describe("credential custody on revoke and cleanup", () => {
  it("cleanup with a file prints the plaintext warning exactly once and reaches cleaned_up", async () => {
    const r = await setupEnded();
    const code = await main(
      r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath),
      r.withDeps({ platform: "linux" }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
    const stderr = r.fx.harness.stderr.join("");
    expect(warningLines(stderr)).toEqual([`stint: ${PLAINTEXT_WARNING}`]);
    expect(stderr).not.toContain(PLAINTEXT_WARNING_WINDOWS);
  });

  it("an injected win32 platform adds the Windows sentence to the same single line", async () => {
    const r = await setupEnded();
    const code = await main(
      r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath),
      r.withDeps({ platform: "win32" }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    const lines = warningLines(r.fx.harness.stderr.join(""));
    expect(lines).toEqual([`stint: ${PLAINTEXT_WARNING} ${PLAINTEXT_WARNING_WINDOWS}`]);
  });

  it("no file remains under the lease's secrets directory after cleaned_up (D-13)", async () => {
    const r = await setupEnded();
    const code = await main(
      r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath),
      r.deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(existsSync(leaseSecretsDir(r.root, r.leaseId))).toBe(false);
  });

  it("leaves the user's own credentials file unchanged", async () => {
    const r = await setupEnded();
    const before = await readFile(r.fx.credentialsPath, "utf8");
    await main(r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath), r.deps);
    expect(await readFile(r.fx.credentialsPath, "utf8")).toBe(before);
  });

  it("under --json the warning stays on stderr and stdout is one JSON document", async () => {
    const r = await setupEnded();
    const code = await main(
      [
        "--store",
        r.root,
        "--json",
        "cleanup",
        r.leaseId,
        "--yes",
        "--credentials",
        r.fx.credentialsPath,
      ],
      r.deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    const stdout = r.fx.harness.stdout.join("");
    expect(stdout).not.toContain(PLAINTEXT_WARNING);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect((JSON.parse(stdout) as { state: string }).state).toBe("cleaned_up");
    expect(warningLines(r.fx.harness.stderr.join(""))).toHaveLength(1);
  });

  it("a second seed of the same credentials writes nothing and prints no warning", async () => {
    const r = await setupEnded();
    const ports = buildRuntimePorts(r.deps, r.root);

    const first = await seedFromCredentials(r.deps, ports, r.leaseId, r.fx.credentials);
    expect(first.written).toEqual([ORDERS]);
    expect(warningLines(r.fx.harness.stderr.join(""))).toHaveLength(1);

    r.clearOutput();
    const second = await seedFromCredentials(r.deps, ports, r.leaseId, r.fx.credentials);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual([ORDERS]);
    expect(r.fx.harness.stderr.join("")).toBe("");
  });

  it("teardown uses the store's rotated token, not the file's (D-08)", async () => {
    const r = await setupEnded();
    as = await startRevocable(r);
    const ports = buildRuntimePorts(r.deps, r.root);
    // The revocable file names the loopback revocation endpoint; the store's copy keeps it.
    const revocable = JSON.parse(await readFile(as.creds, "utf8")) as Record<string, LoadedCredential>;
    const filed = revocable[ORDERS];
    if (filed === undefined) throw new Error("fixture credential missing");
    const fromFile = { ...filed, refreshToken: "file-refresh-token" };
    await seedFromCredentials(r.deps, ports, r.leaseId, { [ORDERS]: fromFile });

    // The provider rotated the refresh token and the store now holds the new one.
    const key = credentialSecretKey(r.leaseId, ORDERS);
    const stored = parseStoredCredential((await ports.secrets.get(key)) ?? "");
    if (stored === undefined || stored.kind === "api_key") throw new Error("seed did not persist an OAuth credential");
    await ports.secrets.put(
      key,
      serializeStoredCredential({ ...stored, refreshToken: "store-rotated-refresh" }),
    );

    const code = await main(r.argv("cleanup", "--yes", "--credentials", as.creds), as.deps());

    expect(code).toBe(EXIT_CODES.ok);
    const bodies = as.requests.join("\n");
    expect(bodies).toContain("store-rotated-refresh");
    expect(bodies).not.toContain("file-refresh-token");
  });

  it("revoke answered n writes nothing under the secrets root and prints no warning", async () => {
    rig = await createTeardownRig();
    const { confirm } = scriptedConfirm(false);
    const code = await main(
      rig.argv("revoke", "--credentials", rig.fx.credentialsPath),
      rig.withDeps({ confirm }),
    );

    expect(code).toBe(EXIT_CODES.consentDeclined);
    expect(existsSync(path.join(rig.root, "secrets"))).toBe(false);
    expect(rig.fx.harness.stderr.join("")).not.toContain(PLAINTEXT_WARNING);
  });

  it("never prints a credential value", async () => {
    const r = await setupEnded();
    await main(r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath), r.deps);
    expect(r.fx.harness.allOutput()).not.toContain(ACCESS_TOKEN);
    expect(r.fx.harness.allOutput()).not.toContain("refresh-token-secret-do-not-leak");
  });
});
