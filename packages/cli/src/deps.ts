/**
 * Injected dependencies for the whole CLI (Pattern 2). Every side-effecting
 * seam — IO, clock, stores, the terminal adapter, keys, trust, credentials —
 * is a member of `CliDeps`, so `main(argv, deps)` is fully testable in-process
 * and no command reaches for `process.*` directly.
 */

import type { HostAdapter, LeaseStore, ReceiptStore } from "@stint/core";

import type { Style } from "./render/style.js";
import type { loadCheckpointPublicKey, loadOrCreateRuntimeKey } from "./keys/runtime-key.js";
import type { loadCredentials, seedVaultFromCredentials } from "./run/credentials.js";
import type { loadTrustStore } from "./trust/trust-store.js";

/** Output sinks. Each call receives already-terminated text (callers add the newline). */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** What an adapter factory may need to know about the invocation. */
export interface AdapterContext {
  /** Under `--json` the human prompt must not pollute stdout. */
  readonly json: boolean;
  /** From `manifest.approvals.timeout_seconds` when a manifest is in hand (display-only countdown). */
  readonly approvalTimeoutSeconds?: number;
}

export interface CliDeps {
  readonly io: CliIo;
  /** Epoch SECONDS (matches lease timestamps). */
  readonly clock: () => number;
  /** Colour helpers; the decision (`--json`, `NO_COLOR`, TTY) is made once by the factory. */
  readonly style: (json: boolean) => Style;
  readonly storeFactory: (root: string) => LeaseStore;
  readonly receiptStoreFactory: (root: string, leaseId: string) => ReceiptStore;
  readonly adapterFactory: (io: CliIo, ctx: AdapterContext) => HostAdapter;
  /** Consent timeout armed by `create` (A3); defaults to 120s. */
  readonly consentTimeoutSeconds?: number;
  readonly keys: {
    readonly loadOrCreate: typeof loadOrCreateRuntimeKey;
    readonly loadPublic: typeof loadCheckpointPublicKey;
  };
  readonly loadTrustStore: typeof loadTrustStore;
  readonly credentials: {
    readonly load: typeof loadCredentials;
    readonly seedVault: typeof seedVaultFromCredentials;
  };
}

/** Options every subcommand can read through `cmd.optsWithGlobals()`. */
export interface GlobalOpts {
  readonly store?: string | undefined;
  readonly json?: boolean | undefined;
}
