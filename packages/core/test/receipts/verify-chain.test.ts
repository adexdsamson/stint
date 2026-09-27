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
