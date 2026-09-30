import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsentDecision } from "@stint/core";
import type { Manifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import {
  NOW,
  createHarness,
  delegatedManifest,
  writeSignedManifest,
} from "./helpers/cli-harness.js";
import type { Harness, HarnessOptions } from "./helpers/cli-harness.js";
import { startPublisherStub } from "./helpers/publisher-stub.js";
import type { PublisherStub, StubBehavior } from "./helpers/publisher-stub.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const grant = (): Promise<ConsentDecision> => Promise.resolve({ decision: "grant" });

/** Sets up a harness with a trusted, signed, delegated manifest on disk. */
async function setup(options: HarnessOptions = {}, trusted = true) {
  const harness = await createHarness(options);
  h = harness;
  const fixture = await writeSignedManifest(harness.root, delegatedManifest());
  if (trusted) await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);
  return { harness, fixture };
}

const create = (harness: Harness, manifestPath: string, ...extra: string[]) =>
  main(["--store", harness.root, "create", manifestPath, ...extra], harness.deps);

async function leases(harness: Harness) {
  return await harness.deps.storeFactory(harness.root).list();
}

describe("stint create", () => {
  it("y: prints the new lease id, saves an ACTIVE lease bound to the manifest hash, exits 0", async () => {
    const { harness, fixture } = await setup({ consent: grant });
    const code = await create(harness, fixture.manifestPath);

    expect(code).toBe(EXIT_CODES.ok);
    const id = harness.stdout.join("").trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await leases(harness);
    expect(stored).toHaveLength(1);
    const lease = stored[0];
    expect(lease?.id).toBe(id);
    expect(lease?.state).toBe("active");
    expect(lease?.grantedAt).toBe(NOW);
    expect(lease?.expiresAt).toBe(NOW + 3600);
    expect(lease?.boundHash).toMatch(/^jcs-sha256:/);
  });

  it("creates the runtime key on first create and never prints private key material", async () => {
    const { harness, fixture } = await setup({ consent: grant });
    await create(harness, fixture.manifestPath);

    const keyFile = path.join(harness.root, "keys", "runtime-ed25519.json");
    const priv = JSON.parse(await readFile(keyFile, "utf8")) as { d: string };
    expect((await stat(path.join(harness.root, "keys", "runtime-ed25519.pub.json"))).isFile()).toBe(
      true,
    );
    expect(harness.allOutput()).not.toContain(priv.d);
  });

  it("--json prints {leaseId,state,expiresAt} on stdout", async () => {
    const { harness, fixture } = await setup({ consent: grant });
    expect(await create(harness, fixture.manifestPath, "--json")).toBe(0);
    const out = JSON.parse(harness.stdout.join("")) as Record<string, unknown>;
    expect(out).toMatchObject({ state: "active", expiresAt: NOW + 3600 });
    expect(typeof out.leaseId).toBe("string");
  });

  it("n / decline: lease is DECLINED and exit is 3", async () => {
    const { harness, fixture } = await setup({
      consent: () => Promise.resolve({ decision: "decline", reason: "user_declined" }),
    });
    expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.consentDeclined);
    const stored = await leases(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe("declined");
    expect(harness.stdout.join("")).toBe("");
  });

  it("a consent that never answers times out to declined (exit 3), decided by core", async () => {
    const { harness, fixture } = await setup({
      consent: () => new Promise<ConsentDecision>(() => undefined),
      consentTimeoutSeconds: 0.05,
    });
    expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.consentDeclined);
    expect((await leases(harness))[0]?.state).toBe("declined");
  });

  it("an adapter that throws never becomes a grant (declined, exit 3)", async () => {
    const { harness, fixture } = await setup({
      consent: () => Promise.reject(new Error("terminal exploded")),
    });
    expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.consentDeclined);
    expect((await leases(harness))[0]?.state).toBe("declined");
    expect(harness.allOutput()).not.toContain("terminal exploded");
  });

  it("a tampered manifest exits 5 before consent, with a fixed message and no stack or jose text", async () => {
    const consent = vi.fn(grant);
    const { harness, fixture } = await setup({ consent });
    const envelope = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
      manifest: { job: { description: string } };
    };
    envelope.manifest.job.description = "Something else entirely";
    await writeFile(fixture.manifestPath, JSON.stringify(envelope));

    expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.manifestInvalid);
    expect(consent).not.toHaveBeenCalled();
    expect(await leases(harness)).toHaveLength(0);
    const err = harness.stderr.join("");
    expect(err).toBe("stint: The manifest failed verification (invalid_signature).\n");
    expect(err).not.toMatch(/jose|JWS|at .*\(|\.ts:|Error/i);
  });

  it("an unparseable or unsigned manifest exits 5", async () => {
    const consent = vi.fn(grant);
    const { harness } = await setup({ consent });
    const junk = path.join(harness.root, "junk.json");
    await writeFile(junk, "{ not json");
    expect(await create(harness, junk)).toBe(EXIT_CODES.manifestInvalid);

    const unsigned = path.join(harness.root, "unsigned.json");
    await writeFile(unsigned, JSON.stringify(delegatedManifest()));
    expect(await create(harness, unsigned)).toBe(EXIT_CODES.manifestInvalid);
    expect(consent).not.toHaveBeenCalled();
  });

  it("invalid UTF-8 is a rejection, not a crash", async () => {
    const { harness } = await setup({ consent: grant });
    const bad = path.join(harness.root, "bad.json");
    await writeFile(bad, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(await create(harness, bad)).toBe(EXIT_CODES.manifestInvalid);
  });

  it("an oversized manifest exits 5 without being parsed", async () => {
    const { harness } = await setup({ consent: grant });
    const big = path.join(harness.root, "big.json");
    await writeFile(big, "x".repeat(262145));
    expect(await create(harness, big)).toBe(EXIT_CODES.manifestInvalid);
  });

  it("an untrusted publisher exits 5 BEFORE consent, saves nothing, and creates no key", async () => {
    const consent = vi.fn(grant);
    const { harness, fixture } = await setup({ consent }, false); // no trust.json
    expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.manifestInvalid);
    expect(consent).not.toHaveBeenCalled();
    expect(await leases(harness)).toHaveLength(0);
    expect(harness.stderr.join("")).toContain("unknown_publisher");
    await expect(stat(path.join(harness.root, "keys"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an unknown kid for a trusted publisher also fails closed", async () => {
    const consent = vi.fn(grant);
    const { harness } = await setup({ consent }, false);
    const other = await signManifestForTest(delegatedManifest(), { kid: "rotated" });
    const file = path.join(harness.root, "rotated.json");
    await writeFile(file, JSON.stringify(other.envelope));
    // Trust only kid "k1"; the manifest is signed with kid "rotated".
    await writeFile(
      path.join(harness.root, "trust.json"),
      JSON.stringify({ "pub.example": { k1: other.publicJwk } }),
    );
    expect(await create(harness, file)).toBe(EXIT_CODES.manifestInvalid);
    expect(consent).not.toHaveBeenCalled();
  });

  it("--trust points at an explicit trust file", async () => {
    const { harness, fixture } = await setup({ consent: grant }, false);
    const trustFile = path.join(harness.root, "elsewhere.json");
    await writeFile(trustFile, fixture.trustJson);
    expect(await create(harness, fixture.manifestPath, "--trust", trustFile)).toBe(0);
  });

  describe("hosted and hybrid manifests need a publisher (closes A8)", () => {
    let stub: PublisherStub | undefined;
    afterEach(async () => {
      await stub?.stop();
      stub = undefined;
    });

    const hostedAuth: Manifest["auth"] = {
      mode: "hosted",
      hosted: { license_issuer: "pub.example", kid: "k1" },
    };
    const hybridAuth: Manifest["auth"] = {
      delegated: [{ provider: "google", resources: ["sheets.orders"] }],
      hosted: { license_issuer: "pub.example", kid: "k1" },
    };
    const authModes: Array<[string, Manifest["auth"]]> = [
      ["hosted", hostedAuth],
      ["hybrid (mode omitted)", hybridAuth],
    ];

    async function setupHosted(auth: Manifest["auth"], consent = vi.fn(grant)) {
      const harness = await createHarness({ consent });
      h = harness;
      const fixture = await writeSignedManifest(harness.root, delegatedManifest({ auth }));
      await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);
      stub = await startPublisherStub();
      return { harness, fixture, consent, stub };
    }

    it.each(authModes)(
      "%s: --publisher issues the license once, activates, and persists publisher.json",
      async (_name, auth) => {
        const { harness, fixture, stub: pub } = await setupHosted(auth);
        const file = await pub.writeBindingFile(harness.root);

        expect(await create(harness, fixture.manifestPath, "--publisher", file)).toBe(
          EXIT_CODES.ok,
        );
        const id = harness.stdout.join("").trim();
        const stored = await leases(harness);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.state).toBe("active");
        expect(pub.hits.issue).toBe(1);

        const persisted = JSON.parse(
          await readFile(path.join(harness.root, "leases", id, "publisher.json"), "utf8"),
        ) as unknown;
        expect(persisted).toEqual(pub.binding);

        // The license is verified and dropped: it reaches neither output nor the store.
        const token = pub.issuedTokens[0] ?? "";
        expect(token).toMatch(/^v4\.public\./);
        expect(harness.allOutput()).not.toContain(token);
        for (const f of ["lease.json", "envelope.json", "publisher.json"]) {
          expect(await readFile(path.join(harness.root, "leases", id, f), "utf8")).not.toContain(
            token,
          );
        }
      },
    );

    it.each(authModes)(
      "%s: without --publisher it exits usage BEFORE consent with a fixed message",
      async (_name, auth) => {
        const { harness, fixture, consent } = await setupHosted(auth);

        expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.usage);
        expect(consent).not.toHaveBeenCalled();
        expect(harness.stderr.join("")).toBe(
          "stint: A lease with hosted or hybrid auth requires --publisher <file>.\n",
        );
        expect(await leases(harness)).toHaveLength(0);
        expect(harness.stderr.join("")).not.toContain("not available in this phase");
      },
    );

    it("a malformed or unsafe --publisher file is a fixed usage error before consent", async () => {
      const { harness, fixture, consent, stub: pub } = await setupHosted(hostedAuth);
      const bad: Array<[string, unknown]> = [
        ["non-loopback http URL", { ...pub.binding, issue_url: "http://publisher.example.test/i" }],
        ["missing invalidate_url", { ...pub.binding, invalidate_url: undefined }],
        ["not a PASERK", { ...pub.binding, license_public_key: "abc" }],
        ["junk PASERK", { ...pub.binding, license_public_key: "k4.public.@@@" }],
        ["not an object", ["x"]],
      ];
      for (const [name, value] of bad) {
        const file = path.join(harness.root, `bad-${name.replace(/\W/g, "-")}.json`);
        await writeFile(file, JSON.stringify(value));
        expect(await create(harness, fixture.manifestPath, "--publisher", file), name).toBe(
          EXIT_CODES.usage,
        );
      }
      const junk = path.join(harness.root, "junk-publisher.json");
      await writeFile(junk, "{ not json");
      expect(await create(harness, fixture.manifestPath, "--publisher", junk)).toBe(
        EXIT_CODES.usage,
      );
      expect(
        await create(harness, fixture.manifestPath, "--publisher", path.join(harness.root, "no")),
      ).toBe(EXIT_CODES.usage);

      expect(consent).not.toHaveBeenCalled();
      expect(await leases(harness)).toHaveLength(0);
      const err = harness.stderr.join("");
      expect(err).not.toContain("publisher.example.test");
      expect(err).not.toContain("k4.public.");
      expect(pub.hits.issue).toBe(0);
    });

    it.each<[StubBehavior]>([["garbage"], ["wrong-lease"], ["refuse"]])(
      "a publisher that returns %s fails activation with a fixed message and leaks nothing",
      async (behavior) => {
        const { harness, fixture, stub: pub } = await setupHosted(hybridAuth);
        pub.behavior = behavior;
        const file = await pub.writeBindingFile(harness.root);

        expect(await create(harness, fixture.manifestPath, "--publisher", file)).toBe(
          EXIT_CODES.wrongState,
        );
        expect(harness.stdout.join("")).toBe("");
        expect(harness.stderr.join("")).toBe(
          "stint: The publisher did not issue a verifiable license; no lease was activated.\n",
        );
        const out = harness.allOutput();
        for (const leaked of [
          ...pub.issuedTokens,
          "v4.public.",
          "boom",
          "internal publisher detail",
        ]) {
          expect(out).not.toContain(leaked);
        }
        const stored = await leases(harness);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.state).toBe("failed");
        await expect(
          stat(path.join(harness.root, "leases", stored[0]?.id ?? "x", "publisher.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("a delegated manifest needs no --publisher and persists no publisher.json", async () => {
    const { harness, fixture } = await setup({ consent: grant });
    expect(await create(harness, fixture.manifestPath)).toBe(EXIT_CODES.ok);
    const id = harness.stdout.join("").trim();
    await expect(
      stat(path.join(harness.root, "leases", id, "publisher.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a missing manifest file is a usage error (exit 2)", async () => {
    const { harness } = await setup({ consent: grant });
    expect(await create(harness, path.join(harness.root, "nope.json"))).toBe(EXIT_CODES.usage);
  });

  it("under --json a rejection is {error,code} with a fixed message", async () => {
    const { harness } = await setup({ consent: grant }, false);
    const fixture = await writeSignedManifest(harness.root, delegatedManifest(), "m2.json");
    expect(await create(harness, fixture.manifestPath, "--json")).toBe(EXIT_CODES.manifestInvalid);
    expect(JSON.parse(harness.stdout.join(""))).toEqual({
      error: "The manifest failed verification (unknown_publisher).",
      code: EXIT_CODES.manifestInvalid,
    });
  });
});
