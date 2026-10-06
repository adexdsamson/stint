/**
 * `createFileLeaseArtifactStore` - the file `LeaseArtifactStore` over the
 * existing lease folder files (RT-02): `envelope.json`, `publisher.json` and
 * the new `grants.json`, all under `<root>/leases/<id>/`. It makes the same
 * `mkdir` plus `atomicWriteJson` calls `saveEnvelope` and `savePublisherBinding`
 * make, so the bytes are identical and no v0.1 file is renamed (D-03). Secrets
 * never go through this store; they live under `<root>/secrets/` (D-07).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { LeaseArtifactName, LeaseArtifactStore } from "@stint/core";

import { leaseDir } from "../paths.js";
import { atomicWriteJson, readJsonRetry } from "./atomic-file.js";

export interface FileLeaseArtifactStoreOptions {
  /** Store root directory (see `resolveStoreRoot`). */
  readonly root: string;
}

const FILE_NAMES: Readonly<Record<LeaseArtifactName, string>> = {
  envelope: "envelope.json",
  publisher: "publisher.json",
  grants: "grants.json",
  run_heartbeat: "run-heartbeat.json",
};

export function createFileLeaseArtifactStore(opts: FileLeaseArtifactStoreOptions): LeaseArtifactStore {
  const { root } = opts;
  const fileFor = (leaseId: string, name: LeaseArtifactName): string =>
    path.join(leaseDir(root, leaseId), FILE_NAMES[name]);

  return {
    async get(leaseId: string, name: LeaseArtifactName): Promise<unknown> {
      return await readJsonRetry(fileFor(leaseId, name));
    },

    async put(leaseId: string, name: LeaseArtifactName, value: unknown): Promise<void> {
      const file = fileFor(leaseId, name);
      await mkdir(leaseDir(root, leaseId), { recursive: true });
      await atomicWriteJson(file, value);
    },
  };
}
