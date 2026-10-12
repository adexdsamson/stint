/**
 * Injected dependencies for the whole CLI (Pattern 2). Every side-effecting
 * seam — IO, clock, stores, the terminal adapter, keys, trust, credentials —
 * is a member of `CliDeps`, so `main(argv, deps)` is fully testable in-process
 * and no command reaches for `process.*` directly.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  HostAdapter,
  KeyProvider,
  LeaseArtifactStore,
  LeaseStore,
  ReceiptStore,
  SecretStore,
  Telemetry,
} from "@stint/core";
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
  /** Test seam: how often, in milliseconds, a run checks its own lease (production leaves it unset: 5000). */
  readonly leaseWatchMs?: number;
}

/**
 * Optional seams for `revoke`/`cleanup` only. Production leaves them unset.
 * Tests wrap the default five teardown steps to inject a fault into any one of
 * them (or to count how often a step ran). Plain-http transport to a loopback
 * authorization server is NOT a seam: it is derived from the credentials' own
 * endpoints by the loopback-only rule (`isLoopbackHttp`, D-16).
 */
export interface TeardownSeams {
  readonly decorateSteps?: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
  /**
   * Test seam for the bounded fence wait of `revoke` and `cleanup` (D-13): one
   * poll interval. Production leaves it unset and a real timer is used.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam: the total milliseconds `revoke` and `cleanup` wait for another
   * driver's live fence before exiting 8. Production leaves it unset (30000).
   */
  readonly fenceWaitMs?: number;
}

/**
 * Optional seams for `supervise` only (Phase 9 D-21). Production supplies
 * `shutdown`, `sleep` and `monotonicMs` from `real-deps.ts` (the only place that
 * may touch `process`); tests inject their own. Command code never reads
 * `process`, so a command without these seams runs with a never-aborting signal.
 */
export interface SuperviseSeams {
  /**
   * Starts listening for a stop request and returns the signal the loop and the
   * sweep observe, plus `dispose` to stop listening. Only `supervise` calls it, so
   * every other command keeps the default Ctrl-C behaviour.
   */
  readonly shutdown?: () => { readonly signal: AbortSignal; readonly dispose: () => void };
  /** Waits `ms` and resolves early, without rejecting, when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A monotonic millisecond clock for the loop's own timing (defaults to `performance.now`). */
  readonly monotonicMs?: () => number;
  /** Test seam: how long, in milliseconds, a supervisor lock goes without a heartbeat before it counts as stale (production: 10000, never below 5000). */
  readonly lockStaleMs?: number;
  /** Test seam: how long, in milliseconds, to wait for a live holder's lock before exiting 8 (production: the stale time plus 2000). */
  readonly lockAcquireWindowMs?: number;
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
  /** Optional seams for `supervise`; production-supplied by `real-deps.ts`, test-injected otherwise. */
  readonly supervise?: SuperviseSeams;
  /** Optional observational sink handed to `@stint/runtime`; absent means events are dropped. */
  readonly telemetry?: Telemetry;
  /** Operating-system name for platform-specific wording; defaults to `process.platform`. Tests inject `"win32"` or `"linux"`. */
  readonly platform?: string;
  /** Optional secret custody for a store root; absent means the file store under `<root>/secrets`. */
  readonly secrets?: (root: string) => SecretStore;
  /** Optional per-lease artifact storage for a store root; absent means the lease-folder files. */
  readonly artifacts?: (root: string) => LeaseArtifactStore;
  /** Optional key source for a store root; absent means one built from `keys` (the file key files). */
  readonly keyProvider?: (root: string) => KeyProvider;
  /**
   * Asks a `[y/N]` question on the user's terminal. Resolves `true` only for
   * an explicit yes, `false` for any other answer, and `undefined` when there
   * is no interactive terminal (or the input ended) so the caller can refuse
   * a destructive action rather than assume consent. Absent means no terminal.
   */
  readonly confirm?: (question: string) => Promise<boolean | undefined>;
  /**
   * Asks for a secret (an API key) on the user's terminal with echo muted
   * (10-02, D-A). Resolves the typed value, or `undefined` when there is no
   * interactive terminal or the input ended. Callers MUST treat `undefined`
   * as no entry and refuse, never as an empty secret, and MUST NOT log,
   * receipt or otherwise interpolate the resolved value. Absent means no
   * terminal.
   */
  readonly askSecret?: (prompt: string) => Promise<string | undefined>;
}

/** Options every subcommand can read through `cmd.optsWithGlobals()`. */
export interface GlobalOpts {
  readonly store?: string | undefined;
  readonly json?: boolean | undefined;
}
