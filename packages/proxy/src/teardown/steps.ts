/**
 * The injectable `TeardownStep` port (D-27) and the fixed 5-step order
 * (D-33). `runStepOnce` is the ONE-PASS step runner (D-15): a single
 * attempt per run, any thrown error collapsing to `"failed"` -- never a
 * retry, backoff, or timer inside a step or this runner. Do NOT port
 * ARCHITECTURE.md Pattern 5's `withRetry` wrapper here.
 *
 * The 5 default step implementations below were happy-path placeholders
 * hardened by later plans -- `revoke_oauth` (05-04, D-20/D-22/D-23/D-33/
 * TEAR-02), `invalidate_license` (05-05, D-21/D-33/LIC-04), `cleanup_hook`
 * (this plan, 05-06, D-08 to D-13/TEAR-03), and `final_receipt` (05-03,
 * D-19/D-31) are now real, permanent implementations. `receiptStore`/
 * `signingKey`/`vault`/`license`/`cleanup` are always caller-injected (never
 * read from disk/env); an unverifiable chain or a signing failure is caught
 * by `runStepOnce` and recorded as `"failed"` -- just another step failure,
 * landing `cleanup_incomplete` (D-15, D-19).
 */

import { randomUUID } from "node:crypto";

import { appendEntry, signCheckpoint, verifyChain } from "@stint/core";
import type { Lease, LicenseIssuer, ReceiptStore, TeardownStepName, TeardownStepOutcome } from "@stint/core";
import type { CryptoKey } from "jose";

import type { CredentialVault } from "../vault/credential-vault.js";
import type { RevokeResult } from "../vault/oauth-client.js";
import { postCleanupToken } from "./cleanup-client.js";
import type { PostCleanupTokenOptions } from "./cleanup-client.js";
import { mintCleanupToken } from "./cleanup-token.js";

/**
 * Per-lease `HeldLicense` custody discard seam (D-21, D-22) teardown step 2
 * depends on: whether the runtime currently holds a hosted/hybrid license
 * for `leaseId` (the D-33 delegated-only distinguisher -- no custody entry
 * means no license to invalidate), and dropping the reference so no future
 * reissue can recover it. Mirrors `held-license.ts`'s "discard = drop the
 * reference" discipline without exposing the `HeldLicense` itself: this
 * seam never reads or returns a token, only tracks presence/absence by lease
 * id. No production per-lease license store exists yet (a later phase's
 * concern, once the runtime actually holds licenses at request time); a
 * caller supplies an implementation alongside a `LicenseIssuer` to exercise
 * the real step, exactly like `vault` above does for `revoke_oauth`.
 */
export interface LicenseCustody {
  hasLicense(leaseId: string): boolean;
  discard(leaseId: string): void;
}

/** The injectable per-step port (D-27) -- the fault matrix (Task 2) forces any single step to fail/timeout by swapping in a step that rejects or resolves `"failed"`. */
export interface TeardownStep {
  readonly name: TeardownStepName;
  run(lease: Lease, now: number): Promise<TeardownStepOutcome>;
}

/** The fixed, unconditional 5-step order (D-33) every teardown run walks, for every end reason and auth mode. */
export const TEARDOWN_STEP_ORDER: readonly TeardownStepName[] = [
  "revoke_oauth",
  "invalidate_license",
  "cleanup_hook",
  "delete_cached_data",
  "final_receipt",
];

/**
 * A single attempt at `step` -- no retry/backoff/timer (D-15). Any thrown
 * error (including a rejected promise) is recorded as `"failed"`, never
 * rethrown -- the orchestrator's per-step loop never needs its own
 * try/catch.
 */
export async function runStepOnce(
  step: TeardownStep,
  lease: Lease,
  now: number,
): Promise<TeardownStepOutcome> {
  try {
    return await step.run(lease, now);
  } catch {
    return "failed";
  }
}

function happyPathStep(name: TeardownStepName, outcome: TeardownStepOutcome): TeardownStep {
  return {
    name,
    run(): Promise<TeardownStepOutcome> {
      return Promise.resolve(outcome);
    },
  };
}

/**
 * Appends one `teardown_step` receipt directly (not via `runStepAndPersist`,
 * which only appends a single receipt carrying the step's RETURNED
 * aggregate outcome) -- mirrors `orchestrate.ts`'s private `appendReceipt`:
 * reloads the current chain first so `prevHash` always links to the latest
 * entry, safe to call multiple times in sequence from inside one step.
 */
async function appendTeardownStepReceipt(
  receiptStore: ReceiptStore,
  step: TeardownStepName,
  outcome: TeardownStepOutcome,
  now: number,
): Promise<void> {
  const chain = await receiptStore.load("verified");
  const entry = appendEntry(chain, { chain: "verified", type: "teardown_step", payload: { step, outcome } }, now);
  await receiptStore.append("verified", entry);
}

/** `RevokeResult.kind`'s three members are an exact subset of `TeardownStepOutcome` -- a direct, type-safe mapping (never string-matching or re-deriving the classification). */
function revokeResultToOutcome(result: RevokeResult): TeardownStepOutcome {
  return result.kind;
}

/**
 * The aggregate step-1 outcome for the progress record and receipt D-24
 * requires (TEAR-02): `revoked` ONLY when every credential was revoked
 * (never overclaimed for a partial/mixed result); `failed` if ANY credential
 * failed (the caller must know at least one revoke did not succeed);
 * otherwise `discarded_revocation_unsupported` -- the honest "we could not
 * confirm, for at least one credential, but discarded our copy" ceiling.
 */
function aggregateRevokeOutcome(perCredentialOutcomes: readonly TeardownStepOutcome[]): TeardownStepOutcome {
  if (perCredentialOutcomes.some((outcome) => outcome === "failed")) return "failed";
  if (perCredentialOutcomes.every((outcome) => outcome === "revoked")) return "revoked";
  return "discarded_revocation_unsupported";
}

/**
 * The real `revoke_oauth` (step 1) implementation (D-20, D-22, D-23, D-33,
 * TEAR-02): revokes and discards every credential the vault holds for this
 * lease via `vault.revokeAndDiscardLeaseCredentials` (the refresh token
 * never leaves the vault -- this function only ever sees the closed
 * {@link RevokeResult}). A hosted-only lease with no seeded credential
 * returns `"not_applicable"` (D-33) and makes no revoke call. Otherwise
 * appends ONE `teardown_step` receipt PER credential carrying that
 * credential's own honest outcome (never a raw token/error, D-24, Pitfall
 * 8), then returns the aggregate outcome ({@link aggregateRevokeOutcome})
 * for `runStepAndPersist`'s own progress-record write and receipt.
 */
function createRevokeOauthStep(vault: CredentialVault, receiptStore: ReceiptStore): TeardownStep {
  return {
    name: "revoke_oauth",
    async run(lease: Lease, now: number): Promise<TeardownStepOutcome> {
      const perCredential = await vault.revokeAndDiscardLeaseCredentials(lease.id, now);
      if (perCredential.length === 0) {
        return "not_applicable";
      }

      const outcomes: TeardownStepOutcome[] = [];
      for (const { result } of perCredential) {
        const outcome = revokeResultToOutcome(result);
        outcomes.push(outcome);
        await appendTeardownStepReceipt(receiptStore, "revoke_oauth", outcome, now);
      }

      return aggregateRevokeOutcome(outcomes);
    },
  };
}

/**
 * The real `invalidate_license` (step 2) implementation (D-21, D-33,
 * LIC-04): a lease with no hosted/hybrid license currently in `custody`
 * returns `"not_applicable"` (delegated-only lease, D-33) and never calls
 * `licenseIssuer`. Otherwise it calls `licenseIssuer.invalidate(leaseId)` --
 * stopping any future per-call refresh from reissuing (D-21's "stop refresh
 * means discard custody + refuse reissue, no background loop") -- then
 * discards the `HeldLicense` from `custody` (drops the reference so no
 * reissue can recover it, D-22) and returns `"ok"`. A thrown/rejected
 * `licenseIssuer.invalidate` is not caught here; `runStepOnce` records it as
 * `"failed"`, identically to every other step's failure path.
 */
function createInvalidateLicenseStep(licenseIssuer: LicenseIssuer, custody: LicenseCustody): TeardownStep {
  return {
    name: "invalidate_license",
    async run(lease: Lease): Promise<TeardownStepOutcome> {
      if (!custody.hasLicense(lease.id)) {
        return "not_applicable";
      }
      await licenseIssuer.invalidate(lease.id);
      custody.discard(lease.id);
      return "ok";
    },
  };
}

/**
 * The manifest-derived, runtime-owned cleanup-hook configuration teardown
 * step 3 depends on (D-13): `url` is `null` when the manifest's `cleanup`
 * field is `null` (no publisher hook) -- the step then runs but mints no
 * token and never makes an HTTP call. `timeoutMs` is an optional override of
 * {@link postCleanupToken}'s default client-side timeout, useful for tests
 * that need a fast-failing "unresponsive hook" case.
 */
export interface CleanupHookConfig {
  readonly url: string | null;
  readonly timeoutMs?: number;
}

/**
 * The real `cleanup_hook` (step 3) implementation (D-08 to D-13, TEAR-03): a
 * `null` `cleanup.url` (no publisher hook, D-13) returns `"not_applicable"`
 * immediately and mints no token. Otherwise it mints a FRESH single-use
 * token every attempt (`randomUUID()` jti, D-10 -- never reused across
 * attempts, including retries) via {@link mintCleanupToken} using the SAME
 * Ed25519 key `final_receipt`'s checkpoint signing uses (D-09), POSTs it via
 * the small runtime-owned {@link postCleanupToken} client (D-12, never the
 * `OutboundConnector`), and maps a 2xx to `"attested_ok"` (an ATTESTED
 * publisher claim, never over-trusted as verified, D-12) or anything else
 * (non-2xx, network failure, timeout) to `"failed"`. The token string itself
 * never crosses into a receipt (D-24) -- only this closed outcome does.
 */
function createCleanupHookStep(config: CleanupHookConfig, signingKey: CryptoKey): TeardownStep {
  return {
    name: "cleanup_hook",
    async run(lease: Lease, now: number): Promise<TeardownStepOutcome> {
      if (config.url === null) {
        return "not_applicable";
      }

      const jti = randomUUID();
      const token = await mintCleanupToken(lease.id, jti, now, signingKey);
      const postOpts: PostCleanupTokenOptions =
        config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs };
      const result = await postCleanupToken(config.url, token, postOpts);
      return result.ok ? "attested_ok" : "failed";
    },
  };
}

/**
 * The real `final_receipt` (step 5) implementation (D-19, D-31): loads the
 * currently-persisted verified chain, verifies it, and -- only if it
 * verifies -- signs a checkpoint over its `headHash`/`count` and writes it.
 * A chain that fails to verify, or a signing failure, resolves `"failed"`
 * rather than throwing, so a caller never needs to distinguish "step threw"
 * from "step returned failed" -- both land the same way via `runStepOnce`.
 */
function createFinalReceiptStep(receiptStore: ReceiptStore, signingKey: CryptoKey): TeardownStep {
  return {
    name: "final_receipt",
    async run(_lease: Lease, now: number): Promise<TeardownStepOutcome> {
      const chain = await receiptStore.load("verified");
      const verified = await verifyChain(chain);
      if (!verified.ok) return "failed";
      const checkpoint = await signCheckpoint(
        "verified",
        verified.value.count,
        verified.value.headHash,
        now,
        signingKey,
      );
      await receiptStore.writeCheckpoint(checkpoint);
      return "ok";
    },
  };
}

/**
 * The 5 fixed-order default `TeardownStep`s (D-33), in `TEARDOWN_STEP_ORDER`
 * -- the production defaults a `TeardownDeps.steps` should be built from
 * until 05-05/05-06 supply the real license/cleanup-hook implementations.
 * `revoke_oauth` (05-04) and `final_receipt` (05-03) are real, permanent
 * behavior this and a prior plan ship, not placeholders.
 *
 * `vault`, `license`, and `cleanup` are each OPTIONAL (Rule 3 seam widening,
 * mirrors `ProxyDeps.teardownSteps` being optional in 05-03): when supplied,
 * `vault` swaps in the real structural-RFC-7009 `revoke_oauth`
 * (`createRevokeOauthStep`, 05-04), `license` (an `{ issuer, custody }`
 * pair, so the two collaborators are always supplied together or not at
 * all) swaps in the real `invalidate_license` (`createInvalidateLicenseStep`,
 * 05-05), and `cleanup` swaps in the real single-use cleanup-token
 * `cleanup_hook` (`createCleanupHookStep`, this plan, 05-06). Omitting any
 * of the three keeps that step's prior happy-path placeholder
 * unconditionally, so every pre-05-06 caller that constructs
 * `createDefaultTeardownSteps(receiptStore, signingKey)` with no `vault`/
 * `license`/`cleanup` keeps compiling AND behaving exactly as before -- only
 * a caller that opts in by passing one exercises that step's honest
 * implementation.
 */
export function createDefaultTeardownSteps(
  receiptStore: ReceiptStore,
  signingKey: CryptoKey,
  vault?: CredentialVault,
  license?: { readonly issuer: LicenseIssuer; readonly custody: LicenseCustody },
  cleanup?: CleanupHookConfig,
): readonly TeardownStep[] {
  return [
    vault === undefined ? happyPathStep("revoke_oauth", "revoked") : createRevokeOauthStep(vault, receiptStore),
    license === undefined
      ? happyPathStep("invalidate_license", "ok")
      : createInvalidateLicenseStep(license.issuer, license.custody),
    cleanup === undefined ? happyPathStep("cleanup_hook", "attested_ok") : createCleanupHookStep(cleanup, signingKey),
    happyPathStep("delete_cached_data", "ok"),
    createFinalReceiptStep(receiptStore, signingKey),
  ];
}
