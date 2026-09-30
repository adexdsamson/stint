import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { parseRunProfile } from "../src/run/profile.js";
import { openControllingTerminal } from "../src/run/terminal.js";
import { PROFILE_JSON } from "./helpers/run-fixture.js";

describe("parseRunProfile", () => {
  it("builds a runtime catalog, binding set and public-client OAuth identity", async () => {
    const profile = parseRunProfile(PROFILE_JSON);
    expect(Object.keys(profile.catalog).sort()).toEqual(["read_orders", "send_notice"]);
    expect(profile.bindings.send_notice?.access).toBe("send");
    expect(profile.oauth.client.client_id).toBe("stint-test-client");
    const body = new URLSearchParams();
    await profile.oauth.clientAuth(profile.oauth.as, profile.oauth.client, body, new Headers());
    expect(body.get("client_id")).toBe("stint-test-client");
  });

  const cases: Array<[string, (p: Record<string, unknown>) => unknown]> = [
    ["a non-object", () => 42],
    ["missing catalog", (p) => ({ ...p, catalog: undefined })],
    [
      "an unknown access",
      (p) => ({ ...p, bindings: [{ ...PROFILE_JSON.bindings[0], access: "root" }] }),
    ],
    [
      "a non-boolean irreversible",
      (p) => ({ ...p, bindings: [{ ...PROFILE_JSON.bindings[0], irreversible: "no" }] }),
    ],
    [
      "a duplicate tool name",
      (p) => ({ ...p, catalog: [PROFILE_JSON.catalog[0], PROFILE_JSON.catalog[0]] }),
    ],
    [
      "a client_secret method (secrets are not allowed in a profile)",
      (p) => ({ ...p, oauth: { ...PROFILE_JSON.oauth, auth_method: "client_secret_post" } }),
    ],
    [
      "a non-URL token endpoint",
      (p) => ({
        ...p,
        oauth: { ...PROFILE_JSON.oauth, as: { issuer: "x", token_endpoint: "nope" } },
      }),
    ],
  ];
  it.each(cases)("rejects %s with a fixed usage error", (_name, mutate) => {
    const base = JSON.parse(JSON.stringify(PROFILE_JSON)) as Record<string, unknown>;
    let thrown: unknown;
    try {
      parseRunProfile(mutate(base));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      code: EXIT_CODES.usage,
      safeMessage: "The run profile has an unexpected shape.",
    });
  });
});

describe("openControllingTerminal", () => {
  it("returns undefined (so the adapter denies) when the console cannot be opened", () => {
    const opened: string[] = [];
    const term = openControllingTerminal({
      platform: "linux",
      openSync: (p) => {
        opened.push(p);
        throw new Error("ENXIO");
      },
    });
    expect(term).toBeUndefined();
    expect(opened).toEqual(["/dev/tty"]);
  });

  it("targets CONIN$/CONOUT$ with r+ on Windows and closes what it opened when the handle is not a TTY", () => {
    const calls: Array<[string, string]> = [];
    const closed: number[] = [];
    let fd = 100;
    const term = openControllingTerminal({
      platform: "win32",
      openSync: (p, f) => {
        calls.push([p, f]);
        return fd++;
      },
      closeSync: (n) => {
        closed.push(n);
      },
      isatty: () => false,
    });
    expect(term).toBeUndefined();
    expect(calls).toEqual([
      ["\\\\.\\CONIN$", "r+"],
      ["\\\\.\\CONOUT$", "r+"],
    ]);
    expect(closed).toEqual([100, 101]);
  });
});
