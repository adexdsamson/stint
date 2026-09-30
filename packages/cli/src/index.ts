export { PACKAGE_NAME as PROXY_PACKAGE_NAME } from "@stint/proxy";

export { createJsonLeaseStore } from "./store/json-lease-store.js";
export type { JsonLeaseStoreOptions } from "./store/json-lease-store.js";
export { createJsonReceiptStore } from "./store/json-receipt-store.js";
export type { JsonReceiptStoreOptions } from "./store/json-receipt-store.js";

export {
  createTerminalHostAdapter,
  NoTerminalError,
  NoAnswerError,
} from "./adapter/terminal-host-adapter.js";
export type { TerminalHostAdapterOptions } from "./adapter/terminal-host-adapter.js";
export { renderConsent } from "./adapter/consent-view.js";
export { sanitizeForTerminal } from "./adapter/sanitize.js";
export { createStyle, colorDecision } from "./render/style.js";
export type { Style } from "./render/style.js";

export { buildProgram, main, mapCommander } from "./program.js";
export type { ExitSink } from "./program.js";
export type {
  CliDeps,
  CliIo,
  AdapterContext,
  GlobalOpts,
  RunSeams,
  TeardownSeams,
} from "./deps.js";
export { EXIT_CODES, CliError } from "./exit.js";
export { loadOrCreateRuntimeKey, loadCheckpointPublicKey } from "./keys/runtime-key.js";
export type { RuntimeKey, RuntimePublicJwk } from "./keys/runtime-key.js";
export { loadTrustStore } from "./trust/trust-store.js";
export { loadCredentials, seedVaultFromCredentials } from "./run/credentials.js";
export type { LoadedCredential } from "./run/credentials.js";

export const PACKAGE_NAME = "@stint/cli";
