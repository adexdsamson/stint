/**
 * Shared rig for the `revoke`/`cleanup` tests: a real ACTIVE lease made through
 * `stint create` (so the signed envelope is persisted as in production), a way to
 * rewrite that lease's state, scripted `[y/N]` answers, and a step decorator that
 * records which teardown steps ran and can force one to fail.
 */

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { Lease } from "@stint/core";
import type { TeardownStep } from "@stint/proxy";
import type { ReceiptEntry } from "@stint/spec";

import type { CliDeps, TeardownSeams } from "../../src/deps.js";
import { NOW } from "./cli-harness.js";
import { createRunFixture } from "./run-fixture.js";
import type { RunFixture } from "./run-fixture.js";

export { NOW };

export interface TeardownRig {
  readonly fx: RunFixture;
  readonly root: string;
  readonly leaseId: string;
  readonly deps: CliDeps;
  /** Same deps with overrides (clock, confirm, teardown seam, ...). */
  readonly withDeps: (overrides: Partial<CliDeps>) => CliDeps;
  readonly lease: () => Promise<Lease>;
  /** Rewrites the stored lease (state, teardownProgress, ...). */
  readonly setLease: (patch: Partial<Lease>) => Promise<void>;
  /** Verified-chain entries of one type. */
  readonly entries: (type: ReceiptEntry["type"]) => Promise<readonly ReceiptEntry[]>;
  readonly allReceiptsJson: () => Promise<string>;
  readonly clearOutput: () => void;
  readonly argv: (command: "revoke" | "cleanup", ...rest: string[]) => string[];
}

export async function createTeardownRig(): Promise<TeardownRig> {
  const fx = await createRunFixture();
  const { harness, leaseId } = fx;
  const root = harness.root;
  const store = harness.deps.storeFactory(root);
  const receipts = harness.deps.receiptStoreFactory(root, leaseId);
  return {
    fx,
    root,
    leaseId,
    deps: harness.deps,
    withDeps: (overrides) => ({ ...harness.deps, ...overrides }),
    lease: async () => {
      const lease = await store.load(leaseId);
      if (lease === undefined) throw new Error("rig: lease missing");
      return lease;
    },
    setLease: async (patch) => {
      const lease = await store.load(leaseId);
      if (lease === undefined) throw new Error("rig: lease missing");
      await store.save({ ...lease, ...patch });
    },
    entries: async (type) => (await receipts.load("verified")).filter((e) => e.type === type),
    allReceiptsJson: async () => JSON.stringify(await receipts.load("verified")),
    clearOutput: () => {
      harness.stdout.length = 0;
      harness.stderr.length = 0;
    },
    argv: (command, ...rest) => ["--store", root, command, leaseId, ...rest],
  };
}

/** Writes the fixture credentials with extra non-secret AS fields merged into every entry. */
export async function writeCredentials(
  rig: TeardownRig,
  extra: Record<string, unknown>,
  fileName = "credentials-revocable.json",
): Promise<string> {
  const file = path.join(rig.root, fileName);
  const merged = Object.fromEntries(
    Object.entries(rig.fx.credentials).map(([resource, cred]) => [resource, { ...cred, ...extra }]),
  );
  await writeFile(file, JSON.stringify(merged));
  return file;
}

/** A confirm seam that records the question and answers `answer` (`undefined` = no terminal). */
export function scriptedConfirm(answer: boolean | undefined): {
  readonly confirm: NonNullable<CliDeps["confirm"]>;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
  };
}

/** Records the order steps ran in; `failing` forces that step to resolve `failed` instead of running. */
export function stepRecorder(failing?: TeardownStep["name"]): {
  readonly decorateSteps: NonNullable<NonNullable<CliDeps["teardown"]>["decorateSteps"]>;
  readonly ran: string[];
} {
  const ran: string[] = [];
  return {
    ran,
    decorateSteps: (steps) =>
      steps.map((step): TeardownStep => ({
        name: step.name,
        run: (lease, now) => {
          ran.push(step.name);
          if (step.name === failing) return Promise.resolve("failed");
          return step.run(lease, now);
        },
      })),
  };
}

export interface Revocable {
  /** Credentials file whose entries point at the loopback revocation endpoint. */
  readonly creds: string;
  /** Deps with any extra teardown seams (the loopback AS needs no flag: it is derived, D-16). */
  readonly deps: (extra?: TeardownSeams, overrides?: Partial<CliDeps>) => CliDeps;
  /** Form bodies the authorization server received on its revocation endpoint. */
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

/** A loopback RFC 7009 revocation endpoint (plain http on 127.0.0.1, allowed by the derived loopback rule). */
export async function startRevocable(rig: TeardownRig): Promise<Revocable> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      requests.push(body);
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const creds = await writeCredentials(rig, {
    clientId: "stint-test-client",
    revocationEndpoint: `http://127.0.0.1:${String(port)}/revoke`,
  });
  return {
    creds,
    requests,
    deps: (extra = {}, overrides = {}) => rig.withDeps({ ...overrides, teardown: { ...extra } }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
