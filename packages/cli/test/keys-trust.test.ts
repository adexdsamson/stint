import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@stint/proxy";
import type { OAuthClient } from "@stint/proxy";
import { signManifestForTest } from "@stint/spec/testing";

import { CliError, EXIT_CODES } from "../src/exit.js";
import { loadCheckpointPublicKey, loadOrCreateRuntimeKey } from "../src/keys/runtime-key.js";
import { loadCredentials, seedVaultFromCredentials } from "../src/run/credentials.js";
import { loadTrustStore } from "../src/trust/trust-store.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "stint-keys-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("loadOrCreateRuntimeKey", () => {
  it("creates the private and public JWK files on first call", async () => {
    const key = await loadOrCreateRuntimeKey(root);
    const priv = await readJson(path.join(root, "keys", "runtime-ed25519.json"));
    const pub = await readJson(path.join(root, "keys", "runtime-ed25519.pub.json"));

    expect(priv.kty).toBe("OKP");
    expect(priv.crv).toBe("Ed25519");
    expect(typeof priv.d).toBe("string");
    expect(pub).toEqual({ kty: "OKP", crv: "Ed25519", x: priv.x });
    expect("d" in pub).toBe(false);
    expect(key.publicJwk.x).toBe(pub.x);
    expect(key.kid).not.toBe("");
  });

  it("loads the same key on a second call (stable kid and x)", async () => {
    const first = await loadOrCreateRuntimeKey(root);
    const second = await loadOrCreateRuntimeKey(root);
    expect(second.kid).toBe(first.kid);
    expect(second.publicJwk.x).toBe(first.publicJwk.x);
  });

  it("restores a missing public file from the private key", async () => {
    const first = await loadOrCreateRuntimeKey(root);
    await rm(path.join(root, "keys", "runtime-ed25519.pub.json"));
    await loadOrCreateRuntimeKey(root);
    const pub = await readJson(path.join(root, "keys", "runtime-ed25519.pub.json"));
    expect(pub.x).toBe(first.publicJwk.x);
  });

  it("loadCheckpointPublicKey imports the public half", async () => {
    await loadOrCreateRuntimeKey(root);
    const pub = await loadCheckpointPublicKey(root);
    expect(pub.type).toBe("public");
  });

  it("loadCheckpointPublicKey fails with a fixed message when no key exists", async () => {
    await expect(loadCheckpointPublicKey(root)).rejects.toBeInstanceOf(CliError);
  });

  it("a corrupt private key file fails with a fixed message that does not echo its contents", async () => {
    await mkdir(path.join(root, "keys"), { recursive: true });
    await writeFile(
      path.join(root, "keys", "runtime-ed25519.json"),
      JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "SECRET-BYTES-NOT-A-KEY" }),
    );
    const err = await loadOrCreateRuntimeKey(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).safeMessage).not.toContain("SECRET-BYTES");
  });
});

describe("loadTrustStore", () => {
  it("an absent trust.json yields an empty store (fails closed)", async () => {
    expect(await loadTrustStore(root, {})).toEqual({});
  });

  it("an empty file yields an empty store", async () => {
    await writeFile(path.join(root, "trust.json"), "  \n");
    expect(await loadTrustStore(root, {})).toEqual({});
  });

  it("keeps well-formed entries, drops malformed ones, and strips a private d member", async () => {
    await writeFile(
      path.join(root, "trust.json"),
      JSON.stringify({
        "pub.example": {
          k1: { kty: "OKP", crv: "Ed25519", x: "AAAA", d: "PRIVATE" },
          k2: { kty: "RSA", n: "x", e: "AQAB" },
        },
        "bad.example": "nope",
      }),
    );
    const store = await loadTrustStore(root, {});
    expect(store).toEqual({ "pub.example": { k1: { kty: "OKP", crv: "Ed25519", x: "AAAA" } } });
  });

  it("--trust overrides <root>/trust.json", async () => {
    const other = path.join(root, "other-trust.json");
    await writeFile(
      other,
      JSON.stringify({ "p.example": { a: { kty: "OKP", crv: "Ed25519", x: "BBBB" } } }),
    );
    expect(Object.keys(await loadTrustStore(root, { trust: other }))).toEqual(["p.example"]);
  });

  it("a trust file written from a real signing key round-trips", async () => {
    const { publicJwk } = await signManifestForTest({ publisher: { id: "p.example" } });
    await writeFile(
      path.join(root, "trust.json"),
      JSON.stringify({ "p.example": { "test-key": publicJwk } }),
    );
    expect(await loadTrustStore(root, {})).toEqual({ "p.example": { "test-key": publicJwk } });
  });

  it("invalid JSON throws a CliError(usage)", async () => {
    await writeFile(path.join(root, "trust.json"), "{not json");
    await expect(loadTrustStore(root, {})).rejects.toMatchObject({ code: EXIT_CODES.usage });
  });
});

const validCred = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiry: 2_000_000_000,
  tokenEndpoint: "https://as.example/token",
  resourceIndicator: "https://api.example/sheets",
};

describe("loadCredentials", () => {
  it("maps a valid fixture to Record<resource, SeededCredential>", async () => {
    const file = path.join(root, "creds.json");
    await writeFile(file, JSON.stringify({ "sheets.orders": validCred }));
    expect(await loadCredentials(file)).toEqual({ "sheets.orders": validCred });
  });

  it.each([
    ["not json", "{oops"],
    ["not an object", "[1,2]"],
    ["missing field", JSON.stringify({ r: { ...validCred, refreshToken: undefined } })],
    ["bad expiry type", JSON.stringify({ r: { ...validCred, expiry: "soon" } })],
    ["bad token endpoint", JSON.stringify({ r: { ...validCred, tokenEndpoint: "not a url" } })],
  ])(
    "throws CliError(usage) on a malformed file (%s) without echoing secrets",
    async (_name, body) => {
      const file = path.join(root, "creds.json");
      await writeFile(file, body);
      const err = await loadCredentials(file).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(EXIT_CODES.usage);
      expect((err as CliError).safeMessage).not.toContain("at-1");
    },
  );

  it("an unreadable file throws CliError(usage)", async () => {
    await expect(loadCredentials(path.join(root, "missing.json"))).rejects.toMatchObject({
      code: EXIT_CODES.usage,
    });
  });
});

describe("seedVaultFromCredentials", () => {
  it("calls vault.seedCredential once per resource", () => {
    const seedCredential = vi.fn();
    const vault = { seedCredential } as unknown as ReturnType<typeof createCredentialVault>;
    seedVaultFromCredentials(vault, "lease-1", {
      a: validCred,
      b: { ...validCred, accessToken: "at-2" },
    });
    expect(seedCredential).toHaveBeenCalledTimes(2);
    expect(seedCredential).toHaveBeenCalledWith("lease-1", "a", validCred);
    expect(seedCredential).toHaveBeenCalledWith("lease-1", "b", {
      ...validCred,
      accessToken: "at-2",
    });
  });

  it("seeds a real vault so the token resolves", async () => {
    const vault = createCredentialVault({} as unknown as OAuthClient, () => 1_000);
    seedVaultFromCredentials(vault, "lease-1", { a: validCred });
    await expect(vault.resolveAccessToken("lease-1", "a", 1_000)).resolves.toBe("at-1");
  });
});
