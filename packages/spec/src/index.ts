export const SPEC_VERSION = "alp/0.1";

export { SPEC_ERROR_CODES } from "./errors.js";
export type { SpecErrorCode, SpecError, Result } from "./errors.js";

export { SUPPORTED_SPEC_VERSIONS, validateManifest, validateEnvelopeShape, resolveAuthMode } from "./validate.js";

export type {
  Manifest,
  Agent,
  Publisher,
  Job,
  Verifier,
  ResourceQueryVerifier,
  UserConfirmVerifier,
  NoneVerifier,
  Scope,
  Access,
  Lease,
  Limits,
  Spend,
  ErrorThreshold,
  Approvals,
  ApprovalTrigger,
  Auth,
  AuthMode,
  DelegatedGrant,
  HostedAuth,
  Cleanup,
  CleanupHook,
  PublisherRetains,
} from "./generated/manifest.js";

export type { SignedEnvelope, EnvelopeSignature } from "./generated/envelope.js";
