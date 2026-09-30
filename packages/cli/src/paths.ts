/**
 * Store-root resolution and lease-path safety (D-09, D-10, T-06-01).
 * Layout (dir-per-lease): `<root>/leases/<id>/lease.json`, with per-lease
 * receipts under `<root>/leases/<id>/receipts/`.
 */

import os from "node:os";
import path from "node:path";

import { CliError, EXIT_CODES } from "./exit.js";

const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** `--store` flag, else `STINT_HOME`, else `~/.stint` (D-09). */
export function resolveStoreRoot(opts: { readonly store?: string | undefined }): string {
  const fromEnv = process.env.STINT_HOME;
  if (opts.store !== undefined && opts.store !== "") return opts.store;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return path.join(os.homedir(), ".stint");
}

/** Rejects any id that could escape the store root or name a Windows device. */
export function assertSafeLeaseId(id: string): void {
  if (
    !LEASE_ID_PATTERN.test(id) ||
    id.includes("..") ||
    id.endsWith(".") ||
    WINDOWS_RESERVED.test(id)
  ) {
    throw new CliError(EXIT_CODES.usage, "Invalid lease id.");
  }
}

function assertUnder(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CliError(EXIT_CODES.usage, "Invalid lease id.");
  }
}

/** `<root>/leases/<id>` — validated, and asserted to stay under the store root. */
export function leaseDir(root: string, id: string): string {
  assertSafeLeaseId(id);
  const base = path.resolve(root, "leases");
  const dir = path.resolve(base, id);
  assertUnder(base, dir);
  return dir;
}

/** `<root>/leases/<id>/lease.json`. */
export function leaseFile(root: string, id: string): string {
  return path.join(leaseDir(root, id), "lease.json");
}

/** `<root>/leases` — the directory `list()` scans. */
export function leasesRoot(root: string): string {
  return path.resolve(root, "leases");
}
