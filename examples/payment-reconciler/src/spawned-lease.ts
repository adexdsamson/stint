/**
 * Shared setup for the REAL-PROCESS flows (the built-bin smoke test and the
 * quickstart): the same hermetic world as `runScenario`, but the lease is served
 * by a spawned `stint run` instead of an in-process `runLease`, so it runs on the
 * real wall clock (a child process cannot share an injected clock).
 *
 * `prepareSpawnedLease` stands up the mock authorization server, the mock
 * publisher and the customer services on loopback, acquires both OAuth grants,
 * signs the hybrid manifest, runs `stint create --publisher` to an ACTIVE lease,
 * and writes the JSON run profile plus the credentials file the spawned
 * `stint run --profile --credentials` reads. It returns the handles to drive the
 * rest: a `cli()` runner for further `stint` commands, every secret in play (for
 * "nothing leaked" scans) and a `stop()` that stops every server.
 *
 * Consent: with `interactive: true` the real terminal adapter asks the user;
 * otherwise consent is auto-granted (the caller prints the notice) so the flow
 * finishes deterministically with no terminal (D-11, Pitfall 9).
 *
 * Secrets never reach a log: the CLI's own stdout/stderr are captured, and the
 * only tokens that exist are in the credentials file / the in-memory vault.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRealDeps, createStyle, main } from "@stint/cli";
import type { CliDeps } from "@stint/cli";
import { startMockAuthServer } from "@stint/proxy/testing";

import { buildSignedManifest, writeManifestFiles } from "./manifest.js";
import { startMockPublisher } from "./mocks/publisher.js";
import type { MockPublisher } from "./mocks/publisher.js";
import { startServices } from "./mocks/services.js";
import { acquireCredentialsFile, writeCredentialsFile } from "./oauth/acquire.js";
import { buildRunProfile, PAYSTACK_RESOURCE, SHEETS_RESOURCE, writeJsonProfile } from "./profile.js";
import { createScriptedAdapter } from "./scripted-adapter.js";

/** Options for {@link prepareSpawnedLease}. */
export interface PrepareSpawnedLeaseOptions {
  /** `manifest.approvals.timeout_seconds` (short when no human will answer). */
  readonly approvalTimeoutSeconds: number;
  /** Ask consent on the real terminal (default: auto-grant, no terminal needed). */
  readonly interactive?: boolean;
}

/** A created, ACTIVE lease plus everything needed to spawn `stint run` for it and to clean up. */
export interface SpawnedLease {
  readonly root: string;
  readonly leaseId: string;
  readonly profilePath: string;
  readonly credentialsPath: string;
  readonly publisher: MockPublisher;
  /** Every secret-shaped value in play: access/refresh tokens and every license issued. */
  readonly secrets: () => readonly string[];
  /** Runs a `stint` command against this store, capturing its stdout/stderr. */
  readonly cli: (argv: readonly string[]) => Promise<{ code: number; out: string; err: string }>;
  /** Stops every server (idempotent). */
  readonly stop: () => Promise<void>;
  /** Stops every server and removes the temp directory. */
  readonly dispose: () => Promise<void>;
}

/** Builds the world and an ACTIVE lease. Throws a fixed-text error (never a token) if setup fails. */
export async function prepareSpawnedLease(
  options: PrepareSpawnedLeaseOptions,
): Promise<SpawnedLease> {
  const workDir = await mkdtemp(path.join(tmpdir(), "alp-run-"));
  const root = path.join(workDir, "store");
  await mkdir(root, { recursive: true });

  const stoppers: Array<() => Promise<void>> = [];
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const stopOne of [...stoppers].reverse()) await stopOne().catch(() => undefined);
  };
  const dispose = async (): Promise<void> => {
    await stop();
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    const as = await startMockAuthServer();
    stoppers.push(() => as.stop());
    const publisher = await startMockPublisher();
    stoppers.push(() => publisher.stop());
    const services = await startServices();
    stoppers.push(() => services.stop());

    // Headless PKCE for both resources on the real clock (the child shares it).
    const credentials = await acquireCredentialsFile(as, [PAYSTACK_RESOURCE, SHEETS_RESOURCE]);
    const credentialsPath = await writeCredentialsFile(
      credentials,
      path.join(workDir, "credentials.json"),
    );
    const profilePath = await writeJsonProfile(
      buildRunProfile({
        mockAs: as,
        paystackUrl: services.paystack.url,
        sheetsUrl: services.sheets.url,
      }),
      path.join(workDir, "profile.json"),
    );

    const built = await buildSignedManifest({
      cleanupUrl: publisher.cleanupUrl,
      approvalTimeoutSeconds: options.approvalTimeoutSeconds,
    });
    const { manifestPath } = await writeManifestFiles(root, built);
    const bindingFile = path.join(workDir, "publisher.json");
    await writeFile(
      bindingFile,
      JSON.stringify({
        issue_url: publisher.issueUrl,
        reissue_url: publisher.reissueUrl,
        invalidate_url: publisher.invalidateUrl,
        license_public_key: publisher.licensePublicKeyPaserk,
      }),
    );

    const out: string[] = [];
    const err: string[] = [];
    const real = createRealDeps();
    const scripted = createScriptedAdapter({ consent: "grant", approvals: [] });
    const deps: CliDeps = {
      ...real,
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
      style: () => createStyle(false),
      ...(options.interactive === true ? {} : { adapterFactory: () => scripted }),
      // `--yes` is always passed where a confirmation would otherwise be asked.
      confirm: () => Promise.resolve(undefined),
    };
    const cli = async (
      argv: readonly string[],
    ): Promise<{ code: number; out: string; err: string }> => {
      const outStart = out.length;
      const errStart = err.length;
      const code = await main(["--store", root, ...argv], deps);
      return { code, out: out.slice(outStart).join(""), err: err.slice(errStart).join("") };
    };

    const created = await cli(["create", manifestPath, "--publisher", bindingFile]);
    if (created.code !== 0) throw new Error("Setup failed: `stint create` did not succeed.");
    const leaseId = (created.out.split("\n")[0] ?? "").trim();
    if (leaseId === "") throw new Error("Setup failed: `stint create` printed no lease id.");

    // The cleanup hook verifies the runtime's EdDSA bearer against the key `create` just made.
    publisher.setRuntimePublicKey(await deps.keys.loadPublic(root));

    return {
      root,
      leaseId,
      profilePath,
      credentialsPath,
      publisher,
      secrets: () => [
        ...Object.values(credentials).flatMap((c) => [c.accessToken, c.refreshToken]),
        ...publisher.issuedTokens,
      ],
      cli,
      stop,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
