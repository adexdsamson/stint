/**
 * Plan 10-02 Task 3: the create-time API-key prompt loop (CRED-01, D-A). The
 * key is asked for once per resource with echo muted, shown honestly at
 * consent, and lands only in the secret store at its hashed path: the leak
 * scan walks every lease file and every captured stream for the fixture key.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { credentialSecretKey, parseGrantsArtifact } from "@stint/core";
import type { ConsentDecision, ConsentRequest, HostAdapter } from "@stint/core";
import { parseStoredCredential, serializeStoredCredential } from "@stint/proxy";
import type { Manifest } from "@stint/spec";

import { renderConsent } from "../src/adapter/consent-view.js";
import { EXIT_CODES } from "../src/exit.js";
import { PLAINTEXT_WARNING } from "../src/messages.js";
import { leaseDir, leaseSecretsDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { createStyle } from "../src/render/style.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { createHarness, delegatedManifest, writeSignedManifest } from "./helpers/cli-harness.js";
import type { Harness, HarnessOptions } from "./helpers/cli-harness.js";

// Both creates in the already-seeded scenarios must target one lease id, because
// the secret store is lease-namespaced; the fixed id is a valid lease id.
const FIXED_LEASE_ID = vi.hoisted(() => "lease-10-02-api-key-1");
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => FIXED_LEASE_ID };
});

const PAYSTACK = "paystack.transactions";
const SECRET = "sk_test_fixture_do_not_leak";
const FILE_KEY = "sk_test_from_file_do_not_leak";
const PRESEEDED = "sk_test_preseeded_do_not_leak";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const grant = (): Promise<ConsentDecision> => Promise.resolve({ decision: "grant" });

/** A delegated-only paystack manifest: one API-key provider, one resource. */
function paystackManifest(): Manifest {
  return delegatedManifest({
    auth: { mode: "delegated", delegated: [{ provider: "paystack", resources: [PAYSTACK] }] },
    scopes: [{ resource: PAYSTACK, access: ["read"] }],
  });
}

/** A scriptable `deps.askSecret` double: each call consumes the next scripted answer. */
function askSecretDouble(script: readonly (string | undefined)[]): {
  readonly prompts: string[];
  readonly calls: () => number;
  readonly fn: (prompt: string) => Promise<string | undefined>;
} {
  const prompts: string[] = [];
  let next = 0;
  return {
    prompts,
    calls: () => prompts.length,
    fn: (prompt: string) => {
      prompts.push(prompt);
      const answer = script[next];
      next += 1;
      return Promise.resolve(answer);
    },
  };
}

interface ApiSetup {
  readonly harness: Harness;
  readonly requests: ConsentRequest[];
  readonly credentialsPath: string;
  readonly create: (...extra: string[]) => Promise<number>;
}

async function setup(
  opts: {
    readonly consent?: HarnessOptions["consent"];
    readonly manifest?: Manifest;
    readonly credentials?: unknown;
    readonly askSecret?: ReturnType<typeof askSecretDouble>;
  } = {},
): Promise<ApiSetup> {
  const harness = await createHarness({ consent: opts.consent ?? grant });
  h = harness;
  const requests: ConsentRequest[] = [];
  const inner = harness.deps.adapterFactory;
  const deps = {
    ...harness.deps,
    adapterFactory: (...args: Parameters<typeof inner>): HostAdapter => {
      const adapter = inner(...args);
      return {
        ...adapter,
        requestConsent: (request, signal) => {
          requests.push(request);
          return adapter.requestConsent(request, signal);
        },
      };
    },
    ...(opts.askSecret === undefined ? {} : { askSecret: opts.askSecret.fn }),
  };
  (harness as { deps: typeof deps }).deps = deps;
  const fixture = await writeSignedManifest(harness.root, opts.manifest ?? paystackManifest());
  await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);
  const credentialsPath = path.join(harness.root, "creds.json");
  if (opts.credentials !== undefined) {
    await writeFile(credentialsPath, JSON.stringify(opts.credentials));
  }
  return {
    harness,
    requests,
    credentialsPath,
    create: (...extra: string[]) =>
      main(["--store", harness.root, "create", fixture.manifestPath, ...extra], deps),
  };
}

/** Every file under `dir`, recursively, decoded as raw utf8 bytes. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(await readFile(full, "utf8"));
  }
  return out;
}

async function storedKey(s: ApiSetup, leaseId: string): Promise<string | undefined> {
  const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
  const raw = await ports.secrets.get(credentialSecretKey(leaseId, PAYSTACK));
  const parsed = raw === undefined ? undefined : parseStoredCredential(raw);
  return parsed !== undefined && parsed.kind === "api_key" ? parsed.key : undefined;
}

function warningCount(s: ApiSetup): number {
  return s.harness.stderr
    .join("")
    .split("\n")
    .filter((line) => line.includes(PLAINTEXT_WARNING)).length;
}

describe("create with an interactively entered API key", () => {
  it("exits 0 with an active lease, asks exactly once, and stores the key at its hashed path", async () => {
    const ask = askSecretDouble([SECRET]);
    const s = await setup({ askSecret: ask });
    const code = await s.create("--api-key");

    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(1);
    expect(ask.prompts[0]).toContain(PAYSTACK);
    expect(ask.prompts[0]).toContain("not shown");
    expect(ask.prompts[0]).not.toContain("sk_");

    const lease = (await s.harness.deps.storeFactory(s.harness.root).list())[0];
    expect(lease?.id).toBe(FIXED_LEASE_ID);
    expect(lease?.state).toBe("active");
    expect(await storedKey(s, lease?.id ?? "")).toBe(SECRET);
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    expect(parseGrantsArtifact(await ports.artifacts.get(FIXED_LEASE_ID, "grants"))).toEqual({
      version: 1,
      grants: [{ resource: PAYSTACK, kind: "api_key", revocation: "unsupported" }],
    });
    expect(warningCount(s)).toBe(1);
    expect(s.harness.stdout.join("")).toBe(`${FIXED_LEASE_ID}\n`);
  });

  it("never writes the key to any captured stream or any file in the lease directory", async () => {
    const s = await setup({ askSecret: askSecretDouble([SECRET]) });
    expect(await s.create("--api-key")).toBe(EXIT_CODES.ok);

    const scanned = [s.harness.allOutput(), ...(await filesUnder(leaseDir(s.harness.root, FIXED_LEASE_ID)))];
    expect(scanned.length).toBeGreaterThan(1);
    for (const bytes of scanned) {
      expect(bytes).not.toContain(SECRET);
      expect(bytes).not.toContain("sk_test_fixture");
    }
  });

  it("shows the api_key kind and the not-revocable capability at consent", async () => {
    const s = await setup({ askSecret: askSecretDouble([SECRET]) });
    await s.create("--api-key");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.custody).toEqual({
      storage: "plaintext_file",
      credentials: [{ resource: PAYSTACK, kind: "api_key", revocation: "unsupported" }],
    });
    const rendered = renderConsent(paystackManifest(), createStyle(false), s.requests[0]?.custody);
    expect(rendered).toContain(`${PAYSTACK} (api_key): cannot be revoked by Stint`);
  });

  it("treats an unanswered ask as no entry: exit 0, no secret stored, lease active (CRED-01 optional)", async () => {
    const ask = askSecretDouble([undefined]);
    const s = await setup({ askSecret: ask });
    const code = await s.create("--api-key");

    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(1);
    const lease = (await s.harness.deps.storeFactory(s.harness.root).list())[0];
    expect(lease?.state).toBe("active");
    expect(existsSync(leaseSecretsDir(s.harness.root, FIXED_LEASE_ID))).toBe(false);
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    expect(await ports.secrets.get(credentialSecretKey(FIXED_LEASE_ID, PAYSTACK))).toBeUndefined();
    // The grants artifact still records the delegated resource with the pre-phase
    // unknown-credential view; no api_key record was fabricated for a key nobody entered.
    expect(parseGrantsArtifact(await ports.artifacts.get(FIXED_LEASE_ID, "grants"))).toEqual({
      version: 1,
      grants: [{ resource: PAYSTACK, kind: "oauth" }],
    });
    expect(warningCount(s)).toBe(0);
  });

  it("never asks without the flag: the seam stays silent and the lease is created as before", async () => {
    const ask = askSecretDouble([SECRET]);
    const s = await setup({ askSecret: ask });
    const code = await s.create();

    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(0);
    expect(existsSync(leaseSecretsDir(s.harness.root, FIXED_LEASE_ID))).toBe(false);
    expect(warningCount(s)).toBe(0);
  });

  it("skips entry (no secret, lease still created) under --api-key when there is no askSecret seam", async () => {
    const s = await setup();
    const code = await s.create("--api-key");

    expect(code).toBe(EXIT_CODES.ok);
    expect(existsSync(leaseSecretsDir(s.harness.root, FIXED_LEASE_ID))).toBe(false);
    expect(warningCount(s)).toBe(0);
  });

  it("re-asks once on an empty or whitespace answer; a second empty answer declines and stores nothing", async () => {
    for (const second of ["", "   "]) {
      const ask = askSecretDouble(["", second]);
      const s = await setup({ askSecret: ask });
      const code = await s.create("--api-key");

      expect(code).toBe(EXIT_CODES.consentDeclined);
      expect(s.harness.stderr.join("")).toContain("Consent was not granted; no lease was activated.");
      expect(ask.calls()).toBe(2);
      expect(await storedKey(s, FIXED_LEASE_ID)).toBeUndefined();
    }
  });

  it("an empty first answer followed by no answer is no entry, not a refusal", async () => {
    const ask = askSecretDouble(["", undefined]);
    const s = await setup({ askSecret: ask });
    const code = await s.create("--api-key");

    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(2);
    expect(await storedKey(s, FIXED_LEASE_ID)).toBeUndefined();
  });

  it("accepts the re-asked key when the first answer was empty", async () => {
    const ask = askSecretDouble(["", SECRET]);
    const s = await setup({ askSecret: ask });
    expect(await s.create("--api-key")).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(2);
    expect(await storedKey(s, FIXED_LEASE_ID)).toBe(SECRET);
  });

  it("seeds from a credentials file with no askSecret seam at all (one prompt fewer)", async () => {
    const s = await setup({ credentials: { [PAYSTACK]: { kind: "api_key", key: FILE_KEY } } });
    const code = await s.create("--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.ok);
    expect(await storedKey(s, FIXED_LEASE_ID)).toBe(FILE_KEY);
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    expect(parseGrantsArtifact(await ports.artifacts.get(FIXED_LEASE_ID, "grants"))).toEqual({
      version: 1,
      grants: [{ resource: PAYSTACK, kind: "api_key", revocation: "unsupported" }],
    });
    expect(warningCount(s)).toBe(1);
    expect(s.harness.allOutput()).not.toContain(FILE_KEY);
  });

  it("does not prompt and leaves the store untouched when the resource is already seeded", async () => {
    const ask = askSecretDouble([SECRET]);
    const s = await setup({ askSecret: ask });
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    await ports.secrets.put(
      credentialSecretKey(FIXED_LEASE_ID, PAYSTACK),
      serializeStoredCredential({ kind: "api_key", key: PRESEEDED }),
    );

    const code = await s.create();

    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(0);
    expect(warningCount(s)).toBe(0);
    expect(await storedKey(s, FIXED_LEASE_ID)).toBe(PRESEEDED);
  });

  it("a second create over the same store never re-prompts and reports the resource skipped", async () => {
    const ask = askSecretDouble([SECRET]);
    const s = await setup({ askSecret: ask });
    expect(await s.create("--api-key")).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(1);
    expect(warningCount(s)).toBe(1);

    expect(await s.create("--api-key")).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(1);
    expect(warningCount(s)).toBe(1);
    expect(await storedKey(s, FIXED_LEASE_ID)).toBe(SECRET);
  });
});
