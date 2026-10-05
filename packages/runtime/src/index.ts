/**
 * @stint/runtime (experimental): the host-agnostic Agent Lease Protocol
 * runtime. A host supplies `RuntimePorts`; the runtime owns the lease
 * lifecycle. It imports no Node file-system, path, OS or child-process module
 * and never reads `process` (D-24).
 */

export const PACKAGE_NAME = "@stint/runtime";

export { settleExpired } from "./settle-expired.js";
export { RuntimeError } from "./errors.js";
export type { RuntimeErrorCode } from "./errors.js";
export type { RuntimePorts } from "./ports.js";
export { isLoopbackHttp, allowInsecureForClient } from "./loopback.js";
export {
  PUBLISHER_TIMEOUT_MS,
  httpIssuerTransport,
  createPublisherClient,
  licenseClaimsFromManifest,
} from "./license-http.js";
export { parsePublisherBinding } from "./publisher-binding.js";
export type { PublisherBinding } from "./publisher-binding.js";
