import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair, importJWK } from "jose";
import type { CryptoKey, JWK } from "jose";
import { describe, expect, it } from "vitest";

import type { Checkpoint } from "@stint/spec";

import {
  CHECKPOINT_HEADER,
  signCheckpoint,
  verifyCheckpoint,
} from "../../src/receipts/checkpoint.js";

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

function loadCheckpointInput(): {
  chain: Checkpoint["chain"];
  count: number;
  headHash: string;
  ts: number;
} {
  return JSON.parse(readVector("checkpoint-input.json")) as {
    chain: Checkpoint["chain"];
    count: number;
    headHash: string;
    ts: number;
  };
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

describe("CHECKPOINT_HEADER", () => {
  it("is declared exactly once, at module scope", () => {
    expect(CHECKPOINT_HEADER).toEqual({ alg: "EdDSA" });
  });
});

describe("golden vector: spec/vectors/receipts/checkpoint-*", () => {
  it("signCheckpoint over the fixed input reproduces the pinned deterministic signature", async () => {
    const input = loadCheckpointInput();
    const privateKey = await loadTestPrivateKey();

    const checkpoint = await signCheckpoint(
      input.chain,
      input.count,
      input.headHash,
      input.ts,
      privateKey,
    );

    expect(checkpoint.chain).toBe(input.chain);
    expect(checkpoint.count).toBe(input.count);
    expect(checkpoint.headHash).toBe(input.headHash);
    expect(checkpoint.ts).toBe(input.ts);
    expect(checkpoint.sig).toBe(readVector("checkpoint-expected-sig.txt").trim());
  });
});

describe("signCheckpoint / verifyCheckpoint", () => {
  it("sign-then-verify round trip resolves true with the matching public key", async () => {
    const input = loadCheckpointInput();
    const privateKey = await loadTestPrivateKey();
    const publicKey = await loadTestPublicKey();

    const checkpoint = await signCheckpoint(
      input.chain,
      input.count,
      input.headHash,
      input.ts,
      privateKey,
    );

    await expect(verifyCheckpoint(checkpoint, publicKey)).resolves.toBe(true);
  });

  it("verifyCheckpoint resolves false for a checkpoint signed with a different key (wrong key)", async () => {
    const input = loadCheckpointInput();
    const privateKey = await loadTestPrivateKey();
    const { publicKey: wrongPublicKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });

    const checkpoint = await signCheckpoint(
      input.chain,
      input.count,
      input.headHash,
      input.ts,
      privateKey,
    );

    await expect(verifyCheckpoint(checkpoint, wrongPublicKey)).resolves.toBe(false);
  });

  it("verifyCheckpoint resolves false for a checkpoint with a mutated headHash", async () => {
    const input = loadCheckpointInput();
    const privateKey = await loadTestPrivateKey();
    const publicKey = await loadTestPublicKey();

    const checkpoint = await signCheckpoint(
      input.chain,
      input.count,
      input.headHash,
      input.ts,
      privateKey,
    );
    const tampered: Checkpoint = { ...checkpoint, headHash: "jcs-sha256:" + "f".repeat(64) };

    await expect(verifyCheckpoint(tampered, publicKey)).resolves.toBe(false);
  });

  it("verifyCheckpoint resolves false for a malformed signature", async () => {
    const input = loadCheckpointInput();
    const privateKey = await loadTestPrivateKey();
    const publicKey = await loadTestPublicKey();

    const checkpoint = await signCheckpoint(
      input.chain,
      input.count,
      input.headHash,
      input.ts,
      privateKey,
    );
    const tampered: Checkpoint = { ...checkpoint, sig: "not-a-valid-signature" };

    await expect(verifyCheckpoint(tampered, publicKey)).resolves.toBe(false);
  });
});
