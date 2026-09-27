import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importJWK } from "jose";
import type { CryptoKey, JWK } from "jose";
import { describe, expect, it } from "vitest";

import type { Checkpoint, ReceiptEntry } from "@stint/spec";

import { verifyChain } from "../../src/receipts/chain.js";
import { signCheckpoint } from "../../src/receipts/checkpoint.js";

// packages/core/test/receipts -> packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors", "receipts");

function readVector(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

interface TestKeyFile {
  readonly kid: string;
  readonly kty: string;
  readonly crv: string;
  readonly d: string;
  readonly x: string;
}

function loadGoldenChain(): readonly ReceiptEntry[] {
  return JSON.parse(readVector("chain-input.json")) as readonly ReceiptEntry[];
}

const testKeyRaw = JSON.parse(readVector("checkpoint-key.jwk.json")) as TestKeyFile;

async function loadTestPrivateKey(): Promise<CryptoKey> {
  const jwk: JWK = { kty: testKeyRaw.kty, crv: testKeyRaw.crv, x: testKeyRaw.x, d: testKeyRaw.d };
  return (await importJWK(jwk, "EdDSA")) as CryptoKey;
}

async function loadTestPublicKey(): Promise<CryptoKey> {
  const jwk: JWK = { kty: testKeyRaw.kty, crv: testKeyRaw.crv, x: testKeyRaw.x };
  return (await importJWK(jwk, "EdDSA")) as CryptoKey;
}

async function signCheckpointOverGoldenChain(): Promise<{
  checkpoint: Checkpoint;
  publicKey: CryptoKey;
}> {
  const chain = loadGoldenChain();
  const headHash = readVector("chain-expected-hash.txt").trim();
  const privateKey = await loadTestPrivateKey();
  const publicKey = await loadTestPublicKey();

  const checkpoint = await signCheckpoint(
    "verified",
    chain.length,
    headHash,
    1732104180,
    privateKey,
  );
  return { checkpoint, publicKey };
}

describe("verifyChain: checkpoint anchoring (RCPT-06, D-09)", () => {
  it("ok when the chain's head hash and count match a validly-signed checkpoint", async () => {
    const chain = loadGoldenChain();
    const { checkpoint, publicKey } = await signCheckpointOverGoldenChain();

    const result = await verifyChain(chain, checkpoint, publicKey);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headHash).toBe(checkpoint.headHash);
      expect(result.value.count).toBe(checkpoint.count);
    }
  });

  it('reports "truncated" with brokenAtSeq at the first missing seq when the chain is shorter than the checkpoint count', async () => {
    const fullChain = loadGoldenChain();
    const prefix = fullChain.slice(0, 2); // checkpoint was signed over the full 3-entry chain
    const { checkpoint, publicKey } = await signCheckpointOverGoldenChain();

    const result = await verifyChain(prefix, checkpoint, publicKey);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ brokenAtSeq: prefix.length, reason: "truncated" });
    }
  });

  it('reports "checkpoint_sig_invalid" when the checkpoint signature does not verify', async () => {
    const chain = loadGoldenChain();
    const { checkpoint, publicKey } = await signCheckpointOverGoldenChain();
    const badCheckpoint: Checkpoint = { ...checkpoint, sig: "not-a-valid-signature" };

    const result = await verifyChain(chain, badCheckpoint, publicKey);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        brokenAtSeq: badCheckpoint.count,
        reason: "checkpoint_sig_invalid",
      });
    }
  });

  it('reports "checkpoint_sig_invalid" when no checkpoint public key is supplied', async () => {
    const chain = loadGoldenChain();
    const { checkpoint } = await signCheckpointOverGoldenChain();

    const result = await verifyChain(chain, checkpoint);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toEqual({
        brokenAtSeq: checkpoint.count,
        reason: "checkpoint_sig_invalid",
      });
    }
  });

  it("no-checkpoint call path behaves exactly as the 03-01 genesis walk + hash_mismatch", async () => {
    const chain = loadGoldenChain();
    const result = await verifyChain(chain);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headHash).toBe(readVector("chain-expected-hash.txt").trim());
      expect(result.value.count).toBe(chain.length);
    }
  });
});

describe("verifyChain: reorder vs mutation break-locus (D-09, RCPT-06)", () => {
  it('transposing two adjacent entries reports "reordered" with brokenAtSeq at the first entry whose recomputed link fails', async () => {
    const chain = loadGoldenChain();
    const [entry0, entry1, entry2] = chain;
    if (entry0 === undefined || entry1 === undefined || entry2 === undefined) {
      throw new Error("fixture chain must have at least 3 entries");
    }
    // Swap positions 1 and 2 (their own seq/prevHash fields stay as originally
    // recorded) -- a wholesale reorder, not a content mutation.
    const transposed: ReceiptEntry[] = [entry0, entry2, entry1];

    const result = await verifyChain(transposed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ brokenAtSeq: 2, reason: "reordered" });
    }
  });

  it('mutating an entry\'s payload reports "hash_mismatch" at the entry whose recomputed link then fails', async () => {
    const chain = loadGoldenChain();
    // Mutate seq 1's payload in place (seq/prevHash on entry 1 itself are
    // untouched) -- entry 1's own prevHash check still passes, but its
    // recomputed hash no longer matches what entry 2's prevHash expects,
    // so the break surfaces at seq 2 (the recompute-on-verify design:
    // no per-entry hash is ever stored, so a payload mutation is only
    // detectable once something downstream depends on that entry's hash).
    const mutated: ReceiptEntry[] = chain.map((entry, i) =>
      i === 1 && entry.type === "call"
        ? { ...entry, payload: { ...entry.payload, redactedSummary: "TAMPERED" } }
        : entry,
    );

    const result = await verifyChain(mutated);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ brokenAtSeq: 2, reason: "hash_mismatch" });
    }
  });
});
