/**
 * Plan 10-05 Task 2: typed job-parameter entry at create (SPEC-08). The user,
 * not the agent, supplies the job's fixed inputs: each declaration is asked
 * once in manifest order through the `askJobParameter` seam, an invalid
 * answer is re-asked once with the fixed invalid-value line, the values ride
 * the consent request, and they bind to the lease exactly once, at
 * activation. The three declarations mirror spec/vectors/valid/
 * payment-reconciler.json.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConsentCustody,
  ConsentDecision,
  ConsentParameter,
  ConsentRequest,
  HostAdapter,
} from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { verifyEnvelope } from "@stint/spec";
import type { Manifest, VerifiedManifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";

import { renderConsent } from "../src/adapter/consent-view.js";
import { EXIT_CODES } from "../src/exit.js";
import { jobParameterInvalidMessage } from "../src/messages.js";
import { main } from "../src/program.js";
import type { JobParameterAsk } from "../src/run/job-parameters.js";
import { createHarness, delegatedManifest, writeSignedManifest } from "./helpers/cli-harness.js";
import type { Harness, HarnessOptions } from "./helpers/cli-harness.js";
import { terminalRig } from "./helpers/run-fixture.js";

// One fixed lease id so file-level assertions can name the lease directory.
const FIXED_LEASE_ID = vi.hoisted(() => "lease-10-05-parameters-1");
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => FIXED_LEASE_ID };
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const grant = (): Promise<ConsentDecision> => Promise.resolve({ decision: "grant" });

/** The vector's three declarations on a delegated manifest (hybrid needs a publisher; parameters are auth-independent). */
function parametersManifest(overrides: Partial<Manifest> = {}): Manifest {
  return delegatedManifest({
    job: {
      description: "Match settled Paystack transactions to open orders.",
      parameters: [
        { name: "reference", type: "string" },
        { name: "expected_amount_kobo", type: "integer" },
        { name: "currency", type: "currency" },
      ],
      verifier: { type: "none" },
    },
    ...overrides,
  });
}

/** A scriptable `deps.askJobParameter` double: each call consumes the next scripted answer. */
function askJobParameterDouble(script: readonly (string | undefined)[]): {
  readonly asks: JobParameterAsk[];
  readonly calls: () => number;
  readonly fn: (ask: JobParameterAsk) => Promise<string | undefined>;
} {
  const asks: JobParameterAsk[] = [];
  let next = 0;
  return {
    asks,
    calls: () => asks.length,
    fn: (ask: JobParameterAsk) => {
      asks.push(ask);
      const answer = script[next];
      next += 1;
      return Promise.resolve(answer);
    },
  };
}

interface ParamSetup {
  readonly harness: Harness;
  readonly requests: ConsentRequest[];
  readonly create: (...extra: string[]) => Promise<number>;
}

async function setup(
  opts: {
    readonly consent?: HarnessOptions["consent"];
    readonly manifest?: Manifest;
    readonly askJobParameter?: ReturnType<typeof askJobParameterDouble>;
    readonly askSecret?: (prompt: string) => Promise<string | undefined>;
  } = {},
): Promise<ParamSetup> {
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
    ...(opts.askJobParameter === undefined ? {} : { askJobParameter: opts.askJobParameter.fn }),
    ...(opts.askSecret === undefined ? {} : { askSecret: opts.askSecret }),
  };
  (harness as { deps: typeof deps }).deps = deps;
  const fixture = await writeSignedManifest(harness.root, opts.manifest ?? parametersManifest());
  await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);
  return {
    harness,
    requests,
    create: (...extra: string[]) =>
      main(["--store", harness.root, "create", fixture.manifestPath, ...extra], deps),
  };
}

const leaseFileOf = (s: ParamSetup): string =>
  path.join(s.harness.root, "leases", FIXED_LEASE_ID, "lease.json");

async function storedLease(s: ParamSetup) {
  return (await s.harness.deps.storeFactory(s.harness.root).load(FIXED_LEASE_ID)) ?? undefined;
}

describe("create with typed job parameters", () => {
  it("happy path: exit 0, active lease, jobParameters deep-equal the entered values with kobo as a number", async () => {
    const ask = askJobParameterDouble(["ref_1001", "30050", "NGN"]);
    const s = await setup({ askJobParameter: ask });
    const code = await s.create();

    expect(code).toBe(EXIT_CODES.ok);
    const lease = await storedLease(s);
    expect(lease?.state).toBe("active");
    expect(lease?.jobParameters).toEqual({
      reference: "ref_1001",
      expected_amount_kobo: 30050,
      currency: "NGN",
    });
    expect(typeof lease?.jobParameters?.expected_amount_kobo).toBe("number");
  });

  it("asks exactly once per declaration, in declaration order", async () => {
    const ask = askJobParameterDouble(["ref_1001", "30050", "NGN"]);
    const s = await setup({ askJobParameter: ask });
    await s.create();

    expect(ask.calls()).toBe(3);
    expect(ask.asks.map((entry) => entry.name)).toEqual([
      "reference",
      "expected_amount_kobo",
      "currency",
    ]);
    for (const entry of ask.asks) {
      expect(entry.required).toBe(true);
      expect(entry.invalidRetryMessage).toBeUndefined();
    }
  });

  it("the consent request carries the entered parameters (name, type, value) in declaration order", async () => {
    const s = await setup({ askJobParameter: askJobParameterDouble(["ref_1001", "30050", "NGN"]) });
    await s.create();

    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.parameters).toEqual([
      { name: "reference", type: "string", value: "ref_1001" },
      { name: "expected_amount_kobo", type: "integer", value: 30050 },
      { name: "currency", type: "currency", value: "NGN" },
    ]);
  });

  it("an invalid answer is re-asked once with the fixed invalid-value message; a valid re-answer binds", async () => {
    const integer = askJobParameterDouble(["ref_1001", "30.5", "30050", "NGN"]);
    const sInteger = await setup({ askJobParameter: integer });
    expect(await sInteger.create()).toBe(EXIT_CODES.ok);
    expect(integer.asks[2]?.invalidRetryMessage).toBe(jobParameterInvalidMessage("integer"));
    expect((await storedLease(sInteger))?.jobParameters).toEqual({
      reference: "ref_1001",
      expected_amount_kobo: 30050,
      currency: "NGN",
    });

    const currency = askJobParameterDouble(["ref_1001", "30050", "NG", "NGN"]);
    const sCurrency = await setup({ askJobParameter: currency });
    expect(await sCurrency.create()).toBe(EXIT_CODES.ok);
    expect(currency.asks[3]?.invalidRetryMessage).toBe(jobParameterInvalidMessage("currency"));

    const stringParam = askJobParameterDouble(["", "ref_1", "30050", "NGN"]);
    const sString = await setup({ askJobParameter: stringParam });
    expect(await sString.create()).toBe(EXIT_CODES.ok);
    expect(stringParam.asks[1]?.invalidRetryMessage).toBe(jobParameterInvalidMessage("string"));
    expect((await storedLease(sString))?.jobParameters?.reference).toBe("ref_1");
  });

  it("a second invalid answer declines: exit 3, the fixed message, a declined lease with no jobParameters", async () => {
    const ask = askJobParameterDouble(["ref_1001", "abc", "abc"]);
    const s = await setup({ askJobParameter: ask });
    const code = await s.create();

    expect(code).toBe(EXIT_CODES.consentDeclined);
    expect(s.harness.stderr.join("")).toContain(
      "Consent was not granted; no lease was activated.",
    );
    expect(ask.calls()).toBe(3);
    const lease = await storedLease(s);
    expect(lease?.state).toBe("declined");
    expect(lease?.jobParameters).toBeUndefined();
    const onDisk = JSON.parse(await readFile(leaseFileOf(s), "utf8")) as Record<string, unknown>;
    expect(onDisk.state).toBe("declined");
    expect("jobParameters" in onDisk).toBe(false);
  });

  it("the seam returning undefined declines: exit 3, nothing activated, consent never asked", async () => {
    const ask = askJobParameterDouble([undefined]);
    const s = await setup({ askJobParameter: ask });
    const code = await s.create();

    expect(code).toBe(EXIT_CODES.consentDeclined);
    expect(ask.calls()).toBe(1);
    expect(s.requests).toHaveLength(0);
    expect((await storedLease(s))?.state).toBe("declined");
  });

  it("no askJobParameter seam (no terminal) over a manifest with parameters declines before consent", async () => {
    const s = await setup();
    const code = await s.create();

    expect(code).toBe(EXIT_CODES.consentDeclined);
    expect(s.requests).toHaveLength(0);
    expect((await storedLease(s))?.state).toBe("declined");
  });

  it("an optional parameter answered empty is omitted; answered, it is bound", async () => {
    const manifest = delegatedManifest({
      job: {
        description: "Reconcile the order sheet.",
        parameters: [
          { name: "reference", type: "string" },
          { name: "note", type: "string", required: false },
        ],
        verifier: { type: "none" },
      },
    });

    const skipped = askJobParameterDouble(["ref_2", ""]);
    const sSkipped = await setup({ manifest, askJobParameter: skipped });
    expect(await sSkipped.create()).toBe(EXIT_CODES.ok);
    expect((await storedLease(sSkipped))?.jobParameters).toEqual({ reference: "ref_2" });
    expect(sSkipped.requests[0]?.parameters).toEqual([
      { name: "reference", type: "string", value: "ref_2" },
    ]);

    const answered = askJobParameterDouble(["ref_2", "see ledger"]);
    const sAnswered = await setup({ manifest, askJobParameter: answered });
    expect(await sAnswered.create()).toBe(EXIT_CODES.ok);
    expect((await storedLease(sAnswered))?.jobParameters).toEqual({
      reference: "ref_2",
      note: "see ledger",
    });
  });

  it("a manifest without parameters never asks and binds nothing (back-compat)", async () => {
    const ask = askJobParameterDouble([]);
    const s = await setup({ manifest: delegatedManifest(), askJobParameter: ask });
    const code = await s.create();

    expect(code).toBe(EXIT_CODES.ok);
    expect(ask.calls()).toBe(0);
    expect(s.requests[0]?.parameters).toBeUndefined();
    const lease = await storedLease(s);
    expect(lease?.state).toBe("active");
    expect("jobParameters" in (lease ?? {})).toBe(false);
  });

  it("parameter entry runs before the API-key prompt (10-02 interleaving)", async () => {
    const order: string[] = [];
    const ask = askJobParameterDouble(["ref_1001", "30050", "NGN"]);
    const wrapped = {
      ...ask,
      fn: (entry: JobParameterAsk): Promise<string | undefined> => {
        order.push(`param:${entry.name}`);
        return ask.fn(entry);
      },
    };
    const askSecret = (prompt: string): Promise<string | undefined> => {
      expect(prompt).toContain("paystack.transactions");
      order.push("secret");
      return Promise.resolve(undefined); // skipped entry, the 10-02 semantics
    };
    const s = await setup({
      manifest: parametersManifest({
        scopes: [{ resource: "paystack.transactions", access: ["read"] }],
        auth: {
          mode: "delegated",
          delegated: [{ provider: "paystack", resources: ["paystack.transactions"] }],
        },
      }),
      askJobParameter: wrapped,
      askSecret,
    });

    expect(await s.create("--api-key")).toBe(EXIT_CODES.ok);
    expect(order).toEqual([
      "param:reference",
      "param:expected_amount_kobo",
      "param:currency",
      "secret",
    ]);
  });

  it("jobParameters is written once at activation: read commands never change the stored bytes", async () => {
    const s = await setup({ askJobParameter: askJobParameterDouble(["ref_1001", "30050", "NGN"]) });
    expect(await s.create()).toBe(EXIT_CODES.ok);
    const before = await readFile(leaseFileOf(s), "utf8");

    expect(
      await main(["--store", s.harness.root, "inspect", FIXED_LEASE_ID], s.harness.deps),
    ).toBe(EXIT_CODES.ok);
    expect(
      await main(["--store", s.harness.root, "verify", FIXED_LEASE_ID], s.harness.deps),
    ).toBe(EXIT_CODES.ok);

    expect(await readFile(leaseFileOf(s), "utf8")).toBe(before);
  });

  it("under --json the consent payload still carries the parameters and stdout stays machine-readable", async () => {
    const s = await setup({ askJobParameter: askJobParameterDouble(["ref_1001", "30050", "NGN"]) });
    expect(await s.create("--json")).toBe(EXIT_CODES.ok);

    expect(s.requests[0]?.parameters).toEqual([
      { name: "reference", type: "string", value: "ref_1001" },
      { name: "expected_amount_kobo", type: "integer", value: 30050 },
      { name: "currency", type: "currency", value: "NGN" },
    ]);
    const out = JSON.parse(s.harness.stdout.join("")) as Record<string, unknown>;
    expect(out).toEqual({ leaseId: FIXED_LEASE_ID, state: "active", expiresAt: 1_800_003_600 });
    expect(s.harness.stdout.join("")).not.toContain("reference");
  });
});

describe("the consent screen shows the entered parameters (Task 3)", () => {
  const entered: readonly ConsentParameter[] = [
    { name: "reference", type: "string", value: "ref_1001" },
    { name: "expected_amount_kobo", type: "integer", value: 30050 },
    { name: "currency", type: "currency", value: "NGN" },
  ];

  function custodyWithCredential(): ConsentCustody {
    return {
      storage: "plaintext_file",
      credentials: [{ resource: "paystack.transactions", kind: "oauth", revocation: "unknown" }],
    };
  }

  it("renderConsent: one `name (type): value` row per entered parameter, in declaration order", () => {
    const text = renderConsent(parametersManifest(), undefined, undefined, entered);
    expect(text).toContain("Job parameters");
    expect(text).toContain("reference (string): ref_1001");
    expect(text).toContain("expected_amount_kobo (integer): 30050");
    expect(text).toContain("currency (currency): NGN");
    expect(text.indexOf("reference (string)")).toBeLessThan(text.indexOf("currency (currency)"));
    expect(text.indexOf("Job parameters")).toBeLessThan(text.indexOf("reference (string)"));
    // With credentials present, the parameters section renders above the credentials block.
    const withCustody = renderConsent(parametersManifest(), undefined, custodyWithCredential(), entered);
    expect(withCustody.indexOf("Job parameters")).toBeGreaterThan(-1);
    expect(withCustody.indexOf("Credentials")).toBeGreaterThan(-1);
    expect(withCustody.indexOf("Job parameters")).toBeLessThan(withCustody.indexOf("Credentials"));
  });

  it("renderConsent: no parameters means no section and byte-identical output to before", () => {
    const manifest = parametersManifest();
    expect(renderConsent(manifest)).toBe(renderConsent(manifest, undefined, undefined, undefined));
    expect(renderConsent(manifest)).not.toContain("Job parameters");
    expect(renderConsent(manifest, undefined, undefined, [])).not.toContain("Job parameters");
  });

  it("renderConsent: a value or name carrying terminal escapes renders sanitized", () => {
    const hostile: readonly ConsentParameter[] = [
      { name: "re\u001b[31mference", type: "string", value: "re\u001b[31mg\u0007" },
      { name: "ok", type: "string", value: "a‮b" },
    ];
    const text = renderConsent(parametersManifest(), undefined, undefined, hostile);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("‮");
    expect(text).toContain("reference (string): reg");
  });

  it("the terminal adapter renders the rows before the grant question", async () => {
    const { envelope, trustStore } = await signManifestForTest(parametersManifest());
    const verified = await verifyEnvelope(envelope, trustStore);
    if (!verified.ok) throw new Error("fixture failed verification");
    const manifestValue: VerifiedManifest = verified.value;

    const rig = terminalRig();
    const decision = rig.adapter.requestConsent(
      { consentId: "c-1", manifest: manifestValue, parameters: entered },
      new AbortController().signal,
    );
    await rig.waitFor("Grant this lease?");
    const text = rig.outText();
    expect(text).toContain("reference (string): ref_1001");
    expect(text).toContain("expected_amount_kobo (integer): 30050");
    expect(text).toContain("currency (currency): NGN");
    rig.input.write("y\n");
    await expect(decision).resolves.toEqual({ decision: "grant" });
  });
});

describe("inspect reports the bound parameters (Task 3)", () => {
  it("prints one row per bound parameter, in declaration order", async () => {
    const s = await setup({ askJobParameter: askJobParameterDouble(["ref_1001", "30050", "NGN"]) });
    expect(await s.create()).toBe(EXIT_CODES.ok);

    expect(await main(["--store", s.harness.root, "inspect", FIXED_LEASE_ID], s.harness.deps)).toBe(
      EXIT_CODES.ok,
    );
    const out = s.harness.stdout.join("");
    expect(out).toContain("Job parameters");
    expect(out).toContain("reference: ref_1001");
    expect(out).toContain("expected_amount_kobo: 30050");
    expect(out).toContain("currency: NGN");
    expect(out.indexOf("reference:")).toBeLessThan(out.indexOf("currency:"));
  });

  it("prints no parameter rows and no empty section for a pre-phase lease", async () => {
    const s = await setup({ manifest: delegatedManifest(), askJobParameter: askJobParameterDouble([]) });
    expect(await s.create()).toBe(EXIT_CODES.ok);

    expect(await main(["--store", s.harness.root, "inspect", FIXED_LEASE_ID], s.harness.deps)).toBe(
      EXIT_CODES.ok,
    );
    expect(s.harness.stdout.join("")).not.toContain("Job parameters");
  });

  it("sanitizes a stored value carrying terminal escapes (the store accepts any string)", async () => {
    const harness = await createHarness();
    h = harness;
    await harness.deps.storeFactory(harness.root).save(
      makeTestLease("lease-hostile-param", {
        jobParameters: { reference: "re\u001b[31mg\u0007" },
      }),
    );

    expect(
      await main(["--store", harness.root, "inspect", "lease-hostile-param"], harness.deps),
    ).toBe(EXIT_CODES.ok);
    const out = harness.stdout.join("");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).toContain("reference: reg");
  });
});
