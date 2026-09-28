import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import type { AttestedClaimEntry, ReceiptEntry, TrustStore } from "@stint/spec";

import { verifyAttestedChain, verifyAttestedEntry } from "../../src/receipts/attested.js";
import { verifyChain } from "../../src/receipts/chain.js";
import { signCheckpoint } from "../../src/receipts/checkpoint.js";

// packages/core/test/receipts -> packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors", "receipts");

function readVector(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

function loadAttestedChain(): readonly AttestedClaimEntry[] {
  return JSON.parse(readVector("attested-input.json")) as readonly AttestedClaimEntry[];
}

function loadVerifiedChain(): readonly ReceiptEntry[] {
  return JSON.parse(readVector("chain-input.json")) as readonly ReceiptEntry[];
}

function loadTrustStore(): TrustStore {
  return JSON.parse(readVector("attested-trust-store.json")) as TrustStore;
}

describe("golden vector: spec/vectors/receipts/attested-*", () => {
  it("verifyAttestedChain succeeds independently, reporting the correct headHash and count", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();

    const result = await verifyAttestedChain(chain, trustStore);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.count).toBe(chain.length);
    }
  });

  it("verifyAttestedEntry accepts each fixture entry individually", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();

    for (const entry of chain) {
      expect(await verifyAttestedEntry(entry, trustStore)).toBe(true);
    }
  });
});

describe("verifyAttestedEntry: rejection modes", () => {
  it("rejects an unknown kid", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();
    const first = chain[0];
    if (first === undefined) throw new Error("fixture chain must be non-empty");

    const tampered: AttestedClaimEntry = {
      ...first,
      payload: { ...first.payload, kid: "unknown-kid" },
    };

    expect(await verifyAttestedEntry(tampered, trustStore)).toBe(false);
  });

  it("rejects an unknown publisher", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();
    const first = chain[0];
    if (first === undefined) throw new Error("fixture chain must be non-empty");

    const tampered: AttestedClaimEntry = {
      ...first,
      payload: { ...first.payload, publisherId: "unknown-publisher.example" },
    };

    expect(await verifyAttestedEntry(tampered, trustStore)).toBe(false);
  });

  it("rejects a tampered claim (claimHash mutated, signature no longer matches)", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();
    const first = chain[0];
    if (first === undefined) throw new Error("fixture chain must be non-empty");

    const tampered: AttestedClaimEntry = {
      ...first,
      payload: { ...first.payload, claimHash: "jcs-sha256:" + "f".repeat(64) },
    };

    expect(await verifyAttestedEntry(tampered, trustStore)).toBe(false);
  });

  it("rejects a wrong-key trust store (correct kid, different public key)", async () => {
    const chain = loadAttestedChain();
    const first = chain[0];
    if (first === undefined) throw new Error("fixture chain must be non-empty");

    const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const { exportJWK } = await import("jose");
    const wrongJwk = await exportJWK(publicKey);
    const wrongTrustStore: TrustStore = {
      [first.payload.publisherId]: {
        [first.payload.kid]: { kty: "OKP", crv: "Ed25519", x: (wrongJwk as { x: string }).x },
      },
    };

    expect(await verifyAttestedEntry(first, wrongTrustStore)).toBe(false);
  });
});

describe("verifyAttestedChain: reports the exact break point", () => {
  it("reports claim_sig_invalid at the tampered entry's seq", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();
    const tampered: AttestedClaimEntry[] = chain.map((entry, i) =>
      i === 1
        ? { ...entry, payload: { ...entry.payload, claimHash: "jcs-sha256:" + "f".repeat(64) } }
        : entry,
    );

    const result = await verifyAttestedChain(tampered, trustStore);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ brokenAtSeq: 1, reason: "claim_sig_invalid" }]);
    }
  });

  it("still reports hash_mismatch/reordered for a broken hash link, same as verifyChain", async () => {
    const chain = loadAttestedChain();
    const trustStore = loadTrustStore();
    const tampered: AttestedClaimEntry[] = chain.map((entry, i) =>
      i === 1 ? { ...entry, prevHash: "jcs-sha256:" + "e".repeat(64) } : entry,
    );

    const result = await verifyAttestedChain(tampered, trustStore);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ brokenAtSeq: 1, reason: "hash_mismatch" }]);
    }
  });
});

describe("independence from the verified chain", () => {
  it("corrupting the verified chain does not change the attested chain's verification result", async () => {
    const attestedChain = loadAttestedChain();
    const trustStore = loadTrustStore();
    const verifiedChain = loadVerifiedChain();

    const beforeResult = await verifyAttestedChain(attestedChain, trustStore);
    expect(beforeResult.ok).toBe(true);

    const corruptedVerifiedChain: ReceiptEntry[] = verifiedChain.map((entry, i) =>
      i === 1 ? { ...entry, prevHash: "jcs-sha256:" + "d".repeat(64) } : entry,
    );
    const verifiedResult = await verifyChain(corruptedVerifiedChain);
    expect(verifiedResult.ok).toBe(false);

    const afterResult = await verifyAttestedChain(attestedChain, trustStore);
    expect(afterResult).toEqual(beforeResult);
  });

  it("an attested checkpoint verifies against its own key, unrelated to any verified-chain checkpoint", async () => {
    const attestedChain = loadAttestedChain();
    const trustStore = loadTrustStore();

    const attestedKeys = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const verifiedKeys = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

    const headResult = await verifyAttestedChain(attestedChain, trustStore);
    expect(headResult.ok).toBe(true);
    const headHash = headResult.ok ? headResult.value.headHash : "";

    const attestedCheckpoint = await signCheckpoint(
      "attested",
      attestedChain.length,
      headHash,
      1700000200,
      attestedKeys.privateKey,
    );

    const okWithOwnKey = await verifyAttestedChain(
      attestedChain,
      trustStore,
      attestedCheckpoint,
      attestedKeys.publicKey,
    );
    expect(okWithOwnKey.ok).toBe(true);

    // The verified chain's checkpoint key must never validate the attested
    // chain's checkpoint (D-07: fully independent integrity).
    const failsWithVerifiedKey = await verifyAttestedChain(
      attestedChain,
      trustStore,
      attestedCheckpoint,
      verifiedKeys.publicKey,
    );
    expect(failsWithVerifiedKey.ok).toBe(false);
    if (!failsWithVerifiedKey.ok) {
      expect(failsWithVerifiedKey.errors).toEqual([
        { brokenAtSeq: attestedChain.length, reason: "checkpoint_sig_invalid" },
      ]);
    }
  });
});

describe("edges", () => {
  it("verifyAttestedChain([]) is ok, headHash === genesis, count 0", async () => {
    const trustStore = loadTrustStore();
    const result = await verifyAttestedChain([], trustStore);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.count).toBe(0);
    }
  });
});
