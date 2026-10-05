import { credentialSecretKey } from "@stint/core";
import { parseStoredCredential } from "@stint/proxy";
import { describe, expect, it } from "vitest";

import {
  RuntimeError,
  expectedCredentialResources,
  loadLeaseManifest,
  missingCredentials,
  seedLeaseCredentials,
} from "../src/index.js";
import { buildRig, delegatedManifest, hostedManifest, oauthCredential } from "./helpers.js";

const LEASE = "lease-custody-1";
const TOKEN = "http://localhost:9/token";
const REVOKE = "http://localhost:9/revoke";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("loadLeaseManifest", () => {
  it("rejects an absent envelope with the fixed message", async () => {
    const rig = await buildRig(LEASE, undefined);
    const err = await errorOf(loadLeaseManifest(rig.ports, LEASE));
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).code).toBe("manifest_invalid");
    expect((err as RuntimeError).safeMessage).toBe("The lease has no stored manifest.");
  });

  it("rejects an unparseable envelope", async () => {
    const rig = await buildRig(LEASE, undefined);
    // A value that cannot be serialised to JSON text can never parse as an envelope.
    const garbled = { ...rig.ports.artifacts, get: () => Promise.resolve(() => undefined) };
    const err = await errorOf(loadLeaseManifest({ artifacts: garbled, trust: rig.ports.trust }, LEASE));
    expect((err as RuntimeError).safeMessage).toBe("The stored manifest could not be parsed.");
  });

  it("rejects an envelope no longer trusted, naming only the spec error code", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["a"]));
    const untrusting = { ...rig.ports, trust: () => Promise.resolve({}) };
    const err = await errorOf(loadLeaseManifest(untrusting, LEASE));
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).code).toBe("manifest_invalid");
    expect((err as RuntimeError).safeMessage).toMatch(/^The stored manifest failed verification \([a-z_]+\)\.$/);
  });

  it("returns the verified manifest for a trusted envelope", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["a"]));
    const verified = await loadLeaseManifest(rig.ports, LEASE);
    expect(verified.manifest.publisher.id).toBe("pub.example");
  });
});

describe("expectedCredentialResources", () => {
  it("unions manifest and grants resources, de-duplicated and sorted ascending", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["b", "a"]));
    await rig.ports.artifacts.put(LEASE, "grants", {
      version: 1,
      grants: [
        { resource: "c", kind: "oauth" },
        { resource: "a", kind: "oauth" },
      ],
    });
    const { manifest } = await loadLeaseManifest(rig.ports, LEASE);
    expect(await expectedCredentialResources(rig.ports, LEASE, manifest)).toEqual(["a", "b", "c"]);
  });

  it("is sorted and includes the manifest resources when the grants artifact is absent", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["z", "m", "a"]));
    const { manifest } = await loadLeaseManifest(rig.ports, LEASE);
    expect(await expectedCredentialResources(rig.ports, LEASE, manifest)).toEqual(["a", "m", "z"]);
  });

  it("is empty for a hosted-only manifest with no artifact", async () => {
    const rig = await buildRig(LEASE, hostedManifest());
    const { manifest } = await loadLeaseManifest(rig.ports, LEASE);
    expect(await expectedCredentialResources(rig.ports, LEASE, manifest)).toEqual([]);
  });

  it("ignores a malformed artifact while the manifest resources still count", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["a"]));
    await rig.ports.artifacts.put(LEASE, "grants", { version: 9, grants: "nope" });
    const { manifest } = await loadLeaseManifest(rig.ports, LEASE);
    expect(await expectedCredentialResources(rig.ports, LEASE, manifest)).toEqual(["a"]);
  });
});

describe("missingCredentials", () => {
  it("returns the expected names whose store key is absent, sorted", async () => {
    const rig = await buildRig(LEASE, undefined);
    await rig.ports.secrets.put(credentialSecretKey(LEASE, "b"), "x");
    expect(await missingCredentials(rig.ports, LEASE, ["c", "b", "a"])).toEqual(["a", "c"]);
  });

  it("returns every expected name when the store throws", async () => {
    const rig = await buildRig(LEASE, undefined);
    const broken = {
      secrets: {
        ...rig.ports.secrets,
        get: () => Promise.reject(new Error("store offline")),
      },
    };
    expect(await missingCredentials(broken, LEASE, ["b", "a"])).toEqual(["a", "b"]);
  });
});

describe("seedLeaseCredentials", () => {
  it("writes absent keys and records them in the grants artifact with kind and revocation", async () => {
    const rig = await buildRig(LEASE, undefined);
    const result = await seedLeaseCredentials(rig.ports, LEASE, {
      b: oauthCredential(TOKEN, undefined),
      a: oauthCredential(TOKEN, REVOKE),
      k: { kind: "api_key", key: "sk-live-1" },
    });
    expect(result).toEqual({ written: ["a", "b", "k"], skipped: [] });
    expect(await rig.ports.artifacts.get(LEASE, "grants")).toEqual({
      version: 1,
      grants: [
        { resource: "a", kind: "oauth", revocation: "supported" },
        { resource: "b", kind: "oauth", revocation: "unsupported" },
        { resource: "k", kind: "api_key", revocation: "unsupported" },
      ],
    });
    const stored = await rig.ports.secrets.get(credentialSecretKey(LEASE, "a"));
    expect(parseStoredCredential(stored ?? "")).toMatchObject({ refreshToken: "refresh-token-1" });
  });

  it("does not overwrite a stored credential with a later seed", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(rig.ports, LEASE, {
      a: oauthCredential(TOKEN, REVOKE, { refreshToken: "rotated-refresh" }),
    });
    const second = await seedLeaseCredentials(rig.ports, LEASE, {
      a: oauthCredential(TOKEN, REVOKE, { refreshToken: "stale-from-file" }),
      b: oauthCredential(TOKEN, REVOKE),
    });
    expect(second).toEqual({ written: ["b"], skipped: ["a"] });
    const stored = await rig.ports.secrets.get(credentialSecretKey(LEASE, "a"));
    expect(parseStoredCredential(stored ?? "")).toMatchObject({ refreshToken: "rotated-refresh" });
  });

  it("keeps an existing grants record for another resource", async () => {
    const rig = await buildRig(LEASE, undefined);
    await rig.ports.artifacts.put(LEASE, "grants", {
      version: 1,
      grants: [{ resource: "other", kind: "api_key" }],
    });
    await seedLeaseCredentials(rig.ports, LEASE, { a: oauthCredential(TOKEN, REVOKE) });
    const grants = (await rig.ports.artifacts.get(LEASE, "grants")) as { grants: { resource: string }[] };
    expect(grants.grants.map((g) => g.resource)).toEqual(["a", "other"]);
  });

  it("applies enrich before the write", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(
      rig.ports,
      LEASE,
      { a: oauthCredential(TOKEN, undefined) },
      {
        enrich: (_resource, credential) =>
          credential.kind === "api_key" ? credential : { ...credential, revocationEndpoint: REVOKE },
      },
    );
    const stored = await rig.ports.secrets.get(credentialSecretKey(LEASE, "a"));
    expect(parseStoredCredential(stored ?? "")).toMatchObject({ revocationEndpoint: REVOKE });
    expect(await rig.ports.artifacts.get(LEASE, "grants")).toEqual({
      version: 1,
      grants: [{ resource: "a", kind: "oauth", revocation: "supported" }],
    });
  });

  it("rejects a hostile resource name with a fixed usage error and writes nothing", async () => {
    const rig = await buildRig(LEASE, undefined);
    const err = await errorOf(
      seedLeaseCredentials(rig.ports, LEASE, {
        good: oauthCredential(TOKEN, REVOKE),
        "bad\\name": oauthCredential(TOKEN, REVOKE),
      }),
    );
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).code).toBe("usage");
    expect((err as RuntimeError).safeMessage).toBe("The credentials file has an unexpected shape.");
    expect(await rig.ports.secrets.get(credentialSecretKey(LEASE, "good"))).toBeUndefined();
    expect(await rig.ports.artifacts.get(LEASE, "grants")).toBeUndefined();
  });
});
