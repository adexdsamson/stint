/**
 * @stint/runtime (experimental): the host-agnostic Agent Lease Protocol
 * runtime. A host supplies `RuntimePorts`; the runtime owns the lease
 * lifecycle. It imports no Node file-system, path, OS or child-process module
 * and never reads `process` (D-24).
 */

export const PACKAGE_NAME = "@stint/runtime";

export { settleExpired } from "./settle-expired.js";
export { runSweep } from "./supervisor/sweep.js";
export type { RunSweepOptions, SweepEvent, SweepReport } from "./supervisor/sweep.js";
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
export { loadLeaseManifest } from "./manifest.js";
export { expectedCredentialResources, missingCredentials, seedLeaseCredentials } from "./custody.js";
export type { SeedResult } from "./custody.js";
export { resolveTeardown } from "./resolve-teardown.js";
export type { ResolveTeardownInput, ResolvedTeardown } from "./resolve-teardown.js";
export { createLeaseRuntime, LICENSE_REFRESH_BEFORE_SECONDS } from "./lease-runtime.js";
export type { LeaseRuntimeOptions, RunningLease } from "./lease-runtime.js";
export { enrichFromProfile } from "./profile.js";
export type { RunProfile } from "./profile.js";
