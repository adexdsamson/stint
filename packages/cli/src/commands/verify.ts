/**
 * `stint verify <leaseId>`: explicit receipt-chain integrity check (CLI-02, D-08).
 *
 * A thin renderer over `verifyChain` / `verifyAttestedChain`; no integrity
 * logic lives here. Whenever a chain has a stored checkpoint it is passed to
 * the verifier together with the runtime public key, because a chain walked
 * without its checkpoint cannot notice edits to, or removal of, its newest
 * entries (Pitfall 8).
 */

import { verifyAttestedChain, verifyChain } from "@stint/core";
import type { ReceiptStore } from "@stint/core";
import type { ReceiptChain } from "@stint/spec";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { renderVerifyResult } from "../render/verify.js";

export type VerifyOpts = GlobalOpts;

async function loadChain(receipts: ReceiptStore, chain: ReceiptChain) {
  return {
    entries: await receipts.load(chain),
    checkpoint: await receipts.readCheckpoint(chain),
  };
}

/**
 * The runtime public key, or `undefined` if none was ever written. A missing key
 * is not fatal here: a checkpoint verified without a key reports
 * `checkpoint_sig_invalid`, which fails closed with the chain-broken exit code.
 * A key file that exists but is corrupt still surfaces as a store error.
 */
async function publicKeyOrUndefined(deps: CliDeps, root: string) {
  try {
    return await deps.keys.loadPublic(root);
  } catch (error) {
    if (error instanceof CliError && error.code === EXIT_CODES.internal) return undefined;
    throw error;
  }
}

export async function verifyCommand(
  deps: CliDeps,
  leaseId: string,
  opts: VerifyOpts,
): Promise<number> {
  assertSafeLeaseId(leaseId);
  const json = opts.json === true;
  const root = resolveStoreRoot(opts);
  if ((await deps.storeFactory(root).load(leaseId)) === undefined) {
    throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  }

  const receipts = deps.receiptStoreFactory(root, leaseId);
  const verifiedChain = await loadChain(receipts, "verified");
  const attestedChain = await loadChain(receipts, "attested");
  const anyCheckpoint =
    verifiedChain.checkpoint !== undefined || attestedChain.checkpoint !== undefined;
  const key = anyCheckpoint ? await publicKeyOrUndefined(deps, root) : undefined;

  const verified = await verifyChain(verifiedChain.entries, verifiedChain.checkpoint, key);
  const attested = await verifyAttestedChain(
    attestedChain.entries,
    await deps.loadTrustStore(root),
    attestedChain.checkpoint,
    key,
  );

  const code = verified.ok && attested.ok ? EXIT_CODES.ok : EXIT_CODES.chainBroken;
  if (json) {
    deps.io.out(`${JSON.stringify({ verified, attested })}\n`);
    return code;
  }

  const lines = renderVerifyResult({ verified, attested }, deps.style(false), {
    verified: verifiedChain.checkpoint !== undefined,
    attested: attestedChain.checkpoint !== undefined,
  });
  deps.io.out(`${lines.join("\n")}\n`);
  return code;
}
