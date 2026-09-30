/**
 * Injected dependencies for the whole CLI (Pattern 2). Every side-effecting
 * seam — IO, clock, stores, the terminal adapter, keys, trust, credentials —
 * is a member of `CliDeps`, so `main(argv, deps)` is fully testable in-process
 * and no command reaches for `process.*` directly.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HostAdapter, LeaseStore, ReceiptStore } from "@stint/core";
import type { TeardownStep } from "@stint/proxy";

import type { Style } from "./render/style.js";
import type { loadCheckpointPublicKey, loadOrCreateRuntimeKey } from "./keys/runtime-key.js";
import type { loadCredentials, seedVaultFromCredentials } from "./run/credentials.js";
import type { ControllingTerminal } from "./run/terminal.js";
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

/**
 * Optional seams for `stint run` only. Production leaves both unset (a
 * controlling-terminal handle and `StdioServerTransport`); in-process tests
 * inject a fake terminal and one half of an `InMemoryTransport` pair so no
 * command ever touches the real stdin/stdout.
 */
export interface RunSeams {
  readonly openTerminal?: () => ControllingTerminal | undefined;
  readonly createTransport?: () => Transport;
}

/**
 * Optional seams for `revoke`/`cleanup` only. Production leaves them unset.
 * Tests wrap the default five teardown steps to inject a fault into any one of
 * them (or to count how often a step ran), and may allow a plain-http loopback
 * authorization server so RFC 7009 revocation can be exercised end to end.
 */
export interface TeardownSeams {
  readonly decorateSteps?: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
  /** Loopback test authorization servers only; the HTTPS-only guard stays on when this is unset. */
  readonly allowInsecureRequests?: boolean;
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
  readonly run?: RunSeams;
  readonly teardown?: TeardownSeams;
  /**
   * Asks a `[y/N]` question on the user's terminal. Resolves `true` only for
   * an explicit yes, `false` for any other answer, and `undefined` when there
   * is no interactive terminal (or the input ended) so the caller can refuse
   * a destructive action rather than assume consent. Absent means no terminal.
   */
  readonly confirm?: (question: string) => Promise<boolean | undefined>;
}

/** Options every subcommand can read through `cmd.optsWithGlobals()`. */
export interface GlobalOpts {
  readonly store?: string | undefined;
  readonly json?: boolean | undefined;
}
