export const SPEC_VERSION = "alp/0.1";

export { SPEC_ERROR_CODES } from "./errors.js";
export type { SpecErrorCode, SpecError, Result } from "./errors.js";

export { SUPPORTED_SPEC_VERSIONS, validateManifest, validateEnvelopeShape, resolveAuthMode } from "./validate.js";

export {
  CONTENT_HASH_PREFIX,
  MAX_CANONICAL_DEPTH,
  CanonicalizationError,
  canonicalize,
  hashCanonical,
  hashManifest,
  isContentHash,
} from "./canonical.js";
export type { ContentHash } from "./canonical.js";

export { MAX_ENVELOPE_BYTES, parseEnvelope, verifyEnvelope } from "./envelope.js";
export type { TrustStore, Ed25519PublicJwk, VerifiedManifest } from "./envelope.js";

export { verifyDetached } from "./jws.js";

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

export type {
  ReceiptEntry,
  ReceiptChain,
  CallEntry,
  CallPayload,
  TransitionEntry,
  TransitionPayload,
  TeardownStepEntry,
  TeardownStepPayload,
  AttestedClaimEntry,
  AttestedClaimPayload,
} from "./generated/receipt.js";

export type { Checkpoint } from "./generated/checkpoint.js";
