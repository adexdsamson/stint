/**
 * 10-06 Task 2 (CLI-03): `stint-cli verify-outcome <leaseId> [--profile <file>]`.
 *
 * Real stores under the harness, a real signed envelope on an active lease, a
 * loopback Paystack-verify double, and a JSON profile that names the built-in
 * `verdict` row adapter. A pass completes the lease through the shared receipted
 * path (exit 0); a failed check shows only the closed verdict enum and changes
 * nothing (exit 9); usage problems are exit 2. Nothing printed ever carries the
 * fixture reference, amount, e-mail or key.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HostAdapter, Lease, OutcomeConfirmDecision } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { seedLeaseCredentials } from "@stint/runtime";
import { hashManifest } from "@stint/spec";
import type { Manifest } from "@stint/spec";

import type { CliDeps } from "../src/deps.js";
import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { NOW, createHarness, delegatedManifest, writeSignedManifest } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";
import { PROFILE_JSON, terminalRig } from "./helpers/run-fixture.js";

const LEASE = "lease-10-06-verify-outcome";
const PAYSTACK = "paystack.transactions";
const KEY = "sk_test_do_not_leak_verify_outcome";
const REFERENCE = "ref_FIXTURE_2002";
const EMAIL = "buyer.fixture@example.test";
const PREDICATE = "exists(rows where verdict = 'confirmed') >= 1";
const PROMPT = "Did the payment arrive in the account?";
const PARAMETERS = { reference: REFERENCE, expected_amount_kobo: 45000, currency: "NGN" } as const;
const VERDICT_LINE = /verdict: (confirmed|amount_mismatch|currency_mismatch|not_success|not_found|unknown)\b/;

interface Mock {
  readonly origin: string;
  readonly requests: Array<{ readonly url: string; readonly authorization: string | undefined }>;
  respond: (res: ServerResponse) => void;
  readonly close: () => Promise<void>;
}

/** A loopback Paystack-verify double; `respond` is swapped per test. */
async function startPaystackMock(): Promise<Mock> {
  const requests: Mock["requests"] = [];
  const mock: Mock = {
    origin: "",
    requests,
    respond: (res) => {
      res.statusCode = 200;
      res.end(JSON.stringify(envelope({})));
    },
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    mock.respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(mock, {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  });
}

/** A documented verify envelope with PII and fee fields the output must never carry. */
function envelope(data: Record<string, unknown>): unknown {
  return {
    status: true,
    message: "Verification successful",
    data: {
      id: 77,
      status: "success",
      reference: REFERENCE,
      amount: 45750,
      requested_amount: 45000,
      currency: "NGN",
      fees: 750,
      customer: { email: EMAIL },
      ...data,
    },
  };
}

function manifestWith(verifier: Manifest["job"]["verifier"]): Manifest {
  return delegatedManifest({
    scopes: [{ resource: PAYSTACK, access: ["read"] }],
    job: { description: "Confirm the payment.", verifier },
    auth: { mode: "delegated", delegated: [{ provider: "paystack", resources: [PAYSTACK] }] },
  });
}

const resourceQuery = (): Manifest["job"]["verifier"] => ({
  type: "resource_query",
  resource: PAYSTACK,
  predicate: PREDICATE,
});

interface Rig {
  readonly harness: Harness;
  readonly mock: Mock;
  readonly profilePath: string;
  readonly deps: (overrides?: Partial<CliDeps>) => CliDeps;
  readonly run: (extra?: string[], overrides?: Partial<CliDeps>) => Promise<number>;
  readonly lease: () => Promise<Lease | undefined>;
  readonly chain: () => Promise<string[]>;
  readonly payloads: () => Promise<string>;
}

let rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs) {
    await rig.mock.close();
    await rig.harness.cleanup();
  }
  rigs = [];
});

async function setup(
  verifier: Manifest["job"]["verifier"] = resourceQuery(),
  state: Lease["state"] = "active",
): Promise<Rig> {
  const harness = await createHarness();
  const mock = await startPaystackMock();
  const manifest = manifestWith(verifier);
  const fixture = await writeSignedManifest(harness.root, manifest);
  await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);

  const ports = buildRuntimePorts(harness.deps, harness.root);
  await ports.artifacts.put(LEASE, "envelope", JSON.parse(await readFile(fixture.manifestPath, "utf8")) as unknown);
  await ports.leases.save(
    makeTestLease(LEASE, {
      state,
      boundHash: hashManifest(manifest),
      grantedAt: NOW - 10,
      expiresAt: NOW + 3600,
      jobParameters: PARAMETERS,
    }),
  );
  await seedLeaseCredentials(ports, LEASE, { [PAYSTACK]: { kind: "api_key", key: KEY, origin: mock.origin } }, { manifest });

  const profilePath = path.join(harness.root, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      ...PROFILE_JSON,
      catalog: [PROFILE_JSON.catalog[0]],
      bindings: [{ ...PROFILE_JSON.bindings[0], resource: PAYSTACK, rowAdapter: "verdict" }],
    }),
  );

  const deps = (overrides: Partial<CliDeps> = {}): CliDeps => ({ ...harness.deps, ...overrides });
  const rig: Rig = {
    harness,
    mock,
    profilePath,
    deps,
    run: (extra = [], overrides = {}) =>
      main(["--store", harness.root, "verify-outcome", LEASE, ...extra], deps(overrides)),
    lease: () => harness.deps.storeFactory(harness.root).load(LEASE),
    chain: async () => {
      const entries = await harness.deps.receiptStoreFactory(harness.root, LEASE).load("verified");
      return entries.flatMap((entry) => {
        const payload = entry.payload as { event?: string; outcome?: string; resource?: string };
        if (entry.type === "transition") return [`transition:${payload.event ?? "?"}`];
        if (entry.type === "call") return [`call:${payload.resource ?? "?"}:${payload.outcome ?? "?"}`];
        return [];
      });
    },
    payloads: async () =>
      JSON.stringify(await harness.deps.receiptStoreFactory(harness.root, LEASE).load("verified")),
  };
  rigs.push(rig);
  return rig;
}

function expectNothingLeaks(rig: Rig): void {
  const output = rig.harness.allOutput();
  for (const secret of [KEY, REFERENCE, EMAIL, "45000", "45750", "750", rig.mock.origin]) {
    expect(output, `output must not contain ${secret}`).not.toContain(secret);
  }
}

const profileArgs = (rig: Rig): string[] => ["--profile", rig.profilePath];

function scriptedAdapter(answer: () => Promise<OutcomeConfirmDecision>): { adapter: HostAdapter; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    adapter: {
      requestConsent: () => Promise.reject(new Error("unused")),
      requestApproval: () => Promise.reject(new Error("unused")),
      requestOutcomeConfirmation: (request) => {
        prompts.push(request.prompt);
        return answer();
      },
      notify: () => Promise.resolve(),
    },
  };
}

describe("stint-cli verify-outcome: resource_query over the Paystack verify route", () => {
  it("a confirmed verdict completes the lease: exit 0, the completed line, and the verified chain", async () => {
    const rig = await setup();

    const code = await rig.run(profileArgs(rig));

    expect(code).toBe(EXIT_CODES.ok);
    const out = rig.harness.stdout.join("");
    expect(out).toContain(LEASE);
    expect(out).toMatch(/outcome verified/i);
    expect(["completed", "tearing_down", "cleaned_up", "cleanup_incomplete"]).toContain((await rig.lease())?.state);
    expect((await rig.chain()).slice(0, 3)).toEqual([
      `call:${PAYSTACK}:allowed`,
      "transition:outcome_verified",
      "transition:begin_teardown",
    ]);
    expect(rig.mock.requests).toHaveLength(1);
    expect(rig.mock.requests[0]?.url).toBe(`/transaction/verify/${REFERENCE}`);
    expect(rig.mock.requests[0]?.authorization).toBe(`Bearer ${KEY}`);
    expectNothingLeaks(rig);
  });

  it("a not_success verdict exits 9 with the verdict line, leaves the lease active and appends one denied receipt", async () => {
    const rig = await setup();
    rig.mock.respond = (res) => {
      res.statusCode = 200;
      res.end(JSON.stringify(envelope({ status: "failed" })));
    };

    const code = await rig.run(profileArgs(rig));

    expect(code).toBe(EXIT_CODES.wrongState);
    const err = rig.harness.stderr.join("");
    expect(err).toMatch(VERDICT_LINE);
    expect(err).toContain("not_success");
    expect(err).toContain(LEASE);
    expect((await rig.lease())?.state).toBe("active");
    expect(await rig.chain()).toEqual([`call:${PAYSTACK}:denied`]);
    expectNothingLeaks(rig);
  });

  it.each([
    ["amount_mismatch", { requested_amount: 99999 }],
    ["currency_mismatch", { currency: "USD" }],
  ] as const)("a %s verdict is shown as the enum alone, never the differing values", async (verdict, data) => {
    const rig = await setup();
    rig.mock.respond = (res) => {
      res.statusCode = 200;
      res.end(JSON.stringify(envelope(data)));
    };

    const code = await rig.run(profileArgs(rig));

    expect(code).toBe(EXIT_CODES.wrongState);
    expect(rig.harness.stderr.join("")).toContain(`verdict: ${verdict}`);
    expect(rig.harness.allOutput()).not.toContain("99999");
    expect(rig.harness.allOutput()).not.toContain("USD");
    expect((await rig.lease())?.state).toBe("active");
  });

  it("an unknown reference (404) is the not_found verdict, exit 9, lease active", async () => {
    const rig = await setup();
    rig.mock.respond = (res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: false, message: "Transaction reference not found" }));
    };

    const code = await rig.run(profileArgs(rig));

    expect(code).toBe(EXIT_CODES.wrongState);
    expect(rig.harness.stderr.join("")).toContain("verdict: not_found");
    expect((await rig.lease())?.state).toBe("active");
    expect(rig.harness.allOutput()).not.toContain("Transaction reference not found");
  });

  it("a transient upstream failure is a failed check (exit 9), the generic failed line, a denied read-error receipt, lease active", async () => {
    const rig = await setup();
    rig.mock.respond = (res) => {
      res.statusCode = 503;
      res.end("upstream says: secret detail");
    };

    const code = await rig.run(profileArgs(rig));

    expect(code).toBe(EXIT_CODES.wrongState);
    const err = rig.harness.stderr.join("");
    expect(err).toContain(LEASE);
    expect(err).not.toMatch(VERDICT_LINE);
    expect(rig.harness.allOutput()).not.toContain("secret detail");
    expect((await rig.lease())?.state).toBe("active");
    expect(await rig.chain()).toEqual([`call:${PAYSTACK}:denied`]);
    expect(await rig.payloads()).toContain("verification_read_error");
  });

  it("--json: a pass prints one JSON object with the lease id and state, and no human lines", async () => {
    const rig = await setup();

    const code = await rig.run(["--json", ...profileArgs(rig)]);

    expect(code).toBe(EXIT_CODES.ok);
    const lines = rig.harness.stdout.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(parsed).toMatchObject({ leaseId: LEASE, outcome: "verified" });
    expect(typeof parsed.state).toBe("string");
    expect(rig.harness.stderr.join("")).toBe("");
    expectNothingLeaks(rig);
  });

  it("--json: a failed check prints one object with the verdict enum and exits 9", async () => {
    const rig = await setup();
    rig.mock.respond = (res) => {
      res.statusCode = 200;
      res.end(JSON.stringify(envelope({ status: "abandoned" })));
    };

    const code = await rig.run(["--json", ...profileArgs(rig)]);

    expect(code).toBe(EXIT_CODES.wrongState);
    const lines = rig.harness.stdout.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ leaseId: LEASE, outcome: "not_passed", verdict: "not_success" });
    expect(rig.harness.stderr.join("")).toBe("");
    expectNothingLeaks(rig);
  });
});

describe("stint-cli verify-outcome: usage and state refusals", () => {
  it("a resource_query verifier with no --profile is a usage error naming the flag, and calls nothing", async () => {
    const rig = await setup();

    const code = await rig.run();

    expect(code).toBe(EXIT_CODES.usage);
    expect(rig.harness.stderr.join("")).toContain("--profile");
    expect(rig.mock.requests).toHaveLength(0);
    expect((await rig.lease())?.state).toBe("active");
    expect(await rig.chain()).toEqual([]);
  });

  it("a none verifier is a usage error pointing at revoke", async () => {
    const rig = await setup({ type: "none" });

    const code = await rig.run();

    expect(code).toBe(EXIT_CODES.usage);
    expect(rig.harness.stderr.join("")).toContain("revoke");
    expect((await rig.lease())?.state).toBe("active");
  });

  it("a lease that is not active exits 9 with the fixed not-active message and changes nothing", async () => {
    const rig = await setup(resourceQuery(), "expired");

    const code = await rig.run(profileArgs(rig));

    expect(code).toBe(EXIT_CODES.wrongState);
    expect(rig.harness.stderr.join("")).toContain("not active");
    expect(rig.mock.requests).toHaveLength(0);
    expect((await rig.lease())?.state).toBe("expired");
    expect(await rig.chain()).toEqual([]);
  });

  it("an unknown lease exits 4", async () => {
    const rig = await setup();
    const code = await main(["--store", rig.harness.root, "verify-outcome", "no-such-lease"], rig.deps());
    expect(code).toBe(EXIT_CODES.leaseNotFound);
  });

  it("an unsafe lease id is a usage error", async () => {
    const rig = await setup();
    const code = await main(["--store", rig.harness.root, "verify-outcome", "../escape"], rig.deps());
    expect(code).toBe(EXIT_CODES.usage);
  });

  it("a profile that names an unknown row adapter is a usage error before any read", async () => {
    const rig = await setup();
    await writeFile(
      rig.profilePath,
      JSON.stringify({ ...PROFILE_JSON, bindings: [{ ...PROFILE_JSON.bindings[0], rowAdapter: "orders" }] }),
    );
    const code = await rig.run(profileArgs(rig));
    expect(code).toBe(EXIT_CODES.usage);
    expect(rig.mock.requests).toHaveLength(0);
  });
});

describe("stint-cli verify-outcome: user_confirm at the terminal", () => {
  const userConfirm = (): Manifest["job"]["verifier"] => ({ type: "user_confirm", prompt: PROMPT });

  it("a confirm through the terminal adapter completes the lease: exit 0, the prompt shown, user_confirm receipt first", async () => {
    const rig = await setup(userConfirm());
    const terminal = terminalRig();

    const pending = rig.run([], { adapterFactory: () => terminal.adapter });
    await terminal.waitFor("Did this happen?");
    terminal.input.write("y\n");
    const code = await pending;

    expect(code).toBe(EXIT_CODES.ok);
    expect(terminal.outText()).toContain(PROMPT);
    expect(rig.harness.stdout.join("")).toContain(LEASE);
    expect((await rig.chain()).slice(0, 3)).toEqual([
      "call:user_confirm:allowed",
      "transition:outcome_verified",
      "transition:begin_teardown",
    ]);
    expect(rig.mock.requests).toHaveLength(0);
  });

  it("a reject exits 9 with the generic failed line and leaves the lease active", async () => {
    const rig = await setup(userConfirm());
    const scripted = scriptedAdapter(() => Promise.resolve({ decision: "reject", reason: "user_rejected" }));

    const code = await rig.run([], { adapterFactory: () => scripted.adapter });

    expect(code).toBe(EXIT_CODES.wrongState);
    expect(scripted.prompts).toEqual([PROMPT]);
    expect(rig.harness.stderr.join("")).toContain(LEASE);
    expect((await rig.lease())?.state).toBe("active");
    expect(await rig.chain()).toEqual(["call:user_confirm:denied"]);
  });

  it("an unanswered prompt times out at the armed deadline: exit 9, lease active", async () => {
    const rig = await setup(userConfirm());
    const scripted = scriptedAdapter(() => new Promise<OutcomeConfirmDecision>(() => undefined));

    const code = await rig.run([], { adapterFactory: () => scripted.adapter, consentTimeoutSeconds: 0.05 });

    expect(code).toBe(EXIT_CODES.wrongState);
    expect((await rig.lease())?.state).toBe("active");
    expect(await rig.payloads()).toContain("timeout");
  });

  it("needs no profile", async () => {
    const rig = await setup(userConfirm());
    const scripted = scriptedAdapter(() => Promise.resolve({ decision: "confirm" }));
    const code = await rig.run([], { adapterFactory: () => scripted.adapter });
    expect(code).toBe(EXIT_CODES.ok);
  });
});
