/**
 * The single hash-chain append/verify implementation for both the verified
 * and attested receipt chains (D-04, D-05, D-09, RCPT-02, RCPT-03, RCPT-06).
 *
 * Every hash in this file goes through `@stint/spec`'s `canonicalize`/
 * `hashCanonical` — the ONLY serializer used for hashing anywhere in this
 * repo (see `packages/spec/src/canonical.ts`'s own docstring). Phase 4's
 * proxy and Phase 5's teardown are the two production callers of
 * `appendEntry`; Phase 6's JSON-file `ReceiptStore` persists exactly the
 * `ReceiptEntry[]` this file produces. The footgun avoided: a second, ad hoc
 * serializer (or trusting a stored hash instead of recomputing it) would let
 * a tampered chain look valid — see RESEARCH.md Pitfall 3/4 and D-04's
 * "recompute, never store" rule. `verifyChain` therefore never reads a
 * stored per-entry hash as ground truth; it recomputes each entry's hash
 * from its own canonical bytes and compares against the NEXT entry's stored
 * `prevHash`.
 *
 * Linkage direction (Task 1 decision, confirmed): entry N's `prevHash` is
 * `hashCanonical(entry N-1)` — a pointer to the previous entry's own
 * canonical hash. The genesis entry (seq 0) links to the fixed
 * `GENESIS_PREV_HASH` constant instead of a real previous entry.
 *
 * `verifyChain` optionally anchors to a signed `Checkpoint` (D-06, D-09,
 * RCPT-06): when a checkpoint and its public key are supplied, the
 * checkpoint's own signature is verified first (`checkpoint_sig_invalid` on
 * failure), then the chain walk additionally reports `truncated` when fewer
 * entries are present than the checkpoint's `count` — a wholesale removal of
 * entries after the last checkpoint is otherwise invisible to a pure
 * internal-consistency walk. `verifyChain` is async because
 * checkpoint-signature verification (`verifyCheckpoint`) is inherently async
 * (jose's Web Crypto-backed EdDSA); the no-checkpoint call path performs no
 * awaited work but keeps the same `Promise`-returning signature so callers
 * never need two different call shapes.
 */

import { canonicalize, hashCanonical } from "@stint/spec";
import type { Checkpoint, ReceiptEntry, CallPayload, TransitionPayload, TeardownStepPayload, AttestedClaimPayload } from "@stint/spec";
import type { CryptoKey } from "jose";

import { verifyCheckpoint } from "./checkpoint.js";
import type { ChainVerifyFailure, ReceiptVerifyReason, Result } from "./errors.js";

/**
 * Fixed genesis `prevHash` (Task 1 decision c): `CONTENT_HASH_PREFIX`
 * followed by 64 zero hex characters. The first entry appended to an empty
 * chain links to this constant rather than to a real previous entry;
 * `verifyChain` starts its walk from this same value.
 */
export const GENESIS_PREV_HASH = "jcs-sha256:" + "0".repeat(64);

/**
 * Caller-supplied input to `appendEntry` — carries only non-secret fields
 * (D-16). A `call` payload holds `argsHash` + `redactedSummary`, never raw
 * tool arguments, credentials, tokens or the license; leaking a secret into
 * a receipt is therefore a compile error, not a review discipline.
 */
export type ReceiptEntryInput =
  | { readonly chain: "verified" | "attested"; readonly type: "call"; readonly payload: CallPayload }
  | { readonly chain: "verified" | "attested"; readonly type: "transition"; readonly payload: TransitionPayload }
  | {
      readonly chain: "verified" | "attested";
      readonly type: "teardown_step";
      readonly payload: TeardownStepPayload;
    }
  | {
      readonly chain: "verified" | "attested";
      readonly type: "attested_claim";
      readonly payload: AttestedClaimPayload;
    };

/**
 * Canonical JCS bytes of a receipt entry — exposed so conformance-vector
 * tooling and tests can assert exact byte reproduction without duplicating
 * the canonicalization call (D-05). Never re-implement this with a bare
 * `JSON.stringify`.
 */
export function canonicalizeEntry(entry: ReceiptEntry): string {
  return canonicalize(entry);
}

/**
 * Appends `input` onto `chain`, returning the new entry (D-04). `seq` is the
 * chain's current length; `prevHash` links to `hashCanonical(chain.at(-1))`,
 * or to `GENESIS_PREV_HASH` for the first entry. This entry's own hash is
 * never computed or stored here — `verifyChain` recomputes it on demand.
 */
export function appendEntry(chain: readonly ReceiptEntry[], input: ReceiptEntryInput, now: number): ReceiptEntry {
  const previous = chain.at(-1);
  const prevHash = previous === undefined ? GENESIS_PREV_HASH : hashCanonical(previous);
  const seq = chain.length;

  switch (input.type) {
    case "call":
      return { seq, ts: now, chain: input.chain, type: input.type, prevHash, payload: input.payload };
    case "transition":
      return { seq, ts: now, chain: input.chain, type: input.type, prevHash, payload: input.payload };
    case "teardown_step":
      return { seq, ts: now, chain: input.chain, type: input.type, prevHash, payload: input.payload };
    case "attested_claim":
      return { seq, ts: now, chain: input.chain, type: input.type, prevHash, payload: input.payload };
  }
}

function reject(brokenAtSeq: number, reason: ReceiptVerifyReason): Result<never> {
  const failure: ChainVerifyFailure = { brokenAtSeq, reason };
  return { ok: false, errors: [failure] };
}

/**
 * Walks `chain` from `GENESIS_PREV_HASH`, recomputing each entry's expected
 * link from the previous entry's own canonical hash and comparing against
 * the current entry's stored `prevHash` — never trusting a stored hash
 * (D-04, D-09, RCPT-06). Returns `ok` with the chain's `headHash`/`count` on
 * success (an empty chain is `ok` with `headHash === GENESIS_PREV_HASH` and
 * `count === 0`), or the exact break locus `{ brokenAtSeq, reason }` on the
 * first mismatch.
 *
 * When `checkpoint` is supplied, its signature is verified first via
 * `verifyCheckpoint` (mirroring `checkpoint.ts`'s own fail-closed
 * discipline) — a missing `checkpointPublicKey` or a signature that does
 * not verify both report `"checkpoint_sig_invalid"`, `brokenAtSeq` set to
 * the checkpoint's own `count` (the boundary the checkpoint claims to
 * anchor). The walk then runs exactly as the no-checkpoint path; once it
 * succeeds, a chain shorter than the checkpoint's `count` (entries removed
 * after the last checkpoint) reports `"truncated"`, `brokenAtSeq` at the
 * first absent seq (`chain.length`).
 */
export async function verifyChain(
  chain: readonly ReceiptEntry[],
  checkpoint?: Checkpoint,
  checkpointPublicKey?: CryptoKey,
): Promise<Result<{ headHash: string; count: number }>> {
  if (checkpoint !== undefined) {
    const sigOk = checkpointPublicKey !== undefined && (await verifyCheckpoint(checkpoint, checkpointPublicKey));
    if (!sigOk) {
      return reject(checkpoint.count, "checkpoint_sig_invalid");
    }
  }

  let expectedPrevHash: string = GENESIS_PREV_HASH;

  for (const entry of chain) {
    if (entry.prevHash !== expectedPrevHash) {
      return reject(entry.seq, "hash_mismatch");
    }
    expectedPrevHash = hashCanonical(entry);
  }

  const headHash = expectedPrevHash;
  const count = chain.length;

  if (checkpoint !== undefined && count < checkpoint.count) {
    return reject(count, "truncated");
  }

  return { ok: true, value: { headHash, count } };
}
