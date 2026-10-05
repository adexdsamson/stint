import { describe, expect, it } from "vitest";

import { awaitConsentDecision } from "@stint/core";
import type { ConsentCustody, ConsentRequest } from "@stint/core";
import { verifyEnvelope } from "@stint/spec";
import type { Manifest, VerifiedManifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";

import { renderConsent, renderUnrevocableAcknowledgement } from "../src/adapter/consent-view.js";
import { NoAnswerError } from "../src/adapter/terminal-host-adapter.js";
import {
  CONSENT_CAPABILITY_UNKNOWN_LINE,
  CONSENT_PLAINTEXT_LINE,
  UNREVOCABLE_ACK_QUESTION,
} from "../src/messages.js";
import { delegatedManifest } from "./helpers/cli-harness.js";
import { terminalRig } from "./helpers/run-fixture.js";

const MAIN_QUESTION = "Grant this lease? [y/N]";
const ACK_QUESTION = UNREVOCABLE_ACK_QUESTION.trim();

async function verified(manifest: Manifest): Promise<VerifiedManifest> {
  const { envelope, trustStore } = await signManifestForTest(manifest);
  const result = await verifyEnvelope(envelope, trustStore);
  if (!result.ok) throw new Error(`fixture failed verification: ${JSON.stringify(result.errors)}`);
  return result.value;
}

async function request(custody?: ConsentCustody): Promise<ConsentRequest> {
  const manifest = await verified(delegatedManifest());
  return custody === undefined
    ? { consentId: "c-1", manifest }
    : { consentId: "c-1", manifest, custody };
}

const unsupported: ConsentCustody = {
  storage: "plaintext_file",
  credentials: [{ resource: "sheets.orders", kind: "oauth", revocation: "unsupported" }],
};

describe("renderConsent with custody", () => {
  it("is unchanged when no custody is given", () => {
    const manifest = delegatedManifest();
    expect(renderConsent(manifest)).toBe(renderConsent(manifest, undefined, undefined));
    expect(renderConsent(manifest)).not.toContain("Credentials");
    expect(renderConsent(manifest)).not.toContain(CONSENT_PLAINTEXT_LINE);
  });

  it("lists each credential with its capability and the plaintext line once", () => {
    const text = renderConsent(delegatedManifest(), undefined, {
      storage: "plaintext_file",
      credentials: [
        { resource: "a.one", kind: "oauth", revocation: "supported" },
        { resource: "b.two", kind: "oauth", revocation: "unsupported" },
      ],
    });
    expect(text).toContain("Credentials");
    expect(text).toContain("a.one: can be revoked when the lease ends");
    expect(text).toContain("b.two: cannot be revoked by Stint");
    expect(text.split(CONSENT_PLAINTEXT_LINE)).toHaveLength(2);
    expect(text).not.toContain(CONSENT_CAPABILITY_UNKNOWN_LINE);
  });

  it("says revocation is not yet known and never presents it as revocable", () => {
    const text = renderConsent(delegatedManifest(), undefined, {
      storage: "plaintext_file",
      credentials: [{ resource: "sheets.orders", kind: "oauth", revocation: "unknown" }],
    });
    expect(text).toContain("sheets.orders: revocation not yet known");
    expect(text).toContain(CONSENT_CAPABILITY_UNKNOWN_LINE);
    expect(text).not.toContain("can be revoked when the lease ends");
  });

  it("shows no Credentials section and no plaintext line for storage none", () => {
    const text = renderConsent(delegatedManifest(), undefined, {
      storage: "none",
      credentials: [],
    });
    expect(text).not.toContain("Credentials");
    expect(text).not.toContain(CONSENT_PLAINTEXT_LINE);
  });

  it("sanitizes escape and bidi characters in a resource name", () => {
    const hostile = "x\u001b[31m.evil‮.res";
    const text = renderConsent(delegatedManifest(), undefined, {
      storage: "plaintext_file",
      credentials: [{ resource: hostile, kind: "oauth", revocation: "unsupported" }],
    });
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("‮");
    const ack = renderUnrevocableAcknowledgement([hostile]);
    expect(ack).not.toContain("\u001b");
    expect(ack).not.toContain("‮");
    expect(ack).toContain("cannot be revoked by Stint");
  });
});

describe("terminal requestConsent acknowledgement", () => {
  it("asks two separate questions for an unsupported credential and grants on two yes", async () => {
    const rig = terminalRig();
    const p = rig.adapter.requestConsent(await request(unsupported), new AbortController().signal);
    await rig.waitFor(MAIN_QUESTION);
    expect(rig.outText()).not.toContain(ACK_QUESTION);
    rig.input.write("y\n");
    await rig.waitFor(ACK_QUESTION);
    expect(rig.outText()).toContain("The credential for sheets.orders cannot be revoked by Stint.");
    expect(rig.outText()).toContain("until you rotate it in the provider dashboard");
    rig.input.write("y\n");
    await expect(p).resolves.toEqual({ decision: "grant" });
  });

  it("declines with user_declined when the acknowledgement is answered n", async () => {
    const rig = terminalRig();
    const p = rig.adapter.requestConsent(await request(unsupported), new AbortController().signal);
    await rig.waitFor(MAIN_QUESTION);
    rig.input.write("y\n");
    await rig.waitFor(ACK_QUESTION);
    rig.input.write("n\n");
    await expect(p).resolves.toEqual({ decision: "decline", reason: "user_declined" });
  });

  it("never shows the acknowledgement when the main question is answered n", async () => {
    const rig = terminalRig();
    const p = rig.adapter.requestConsent(await request(unsupported), new AbortController().signal);
    await rig.waitFor(MAIN_QUESTION);
    rig.input.write("n\n");
    await expect(p).resolves.toEqual({ decision: "decline", reason: "user_declined" });
    expect(rig.outText()).not.toContain(ACK_QUESTION);
  });

  it("asks exactly one question when no credential is unsupported", async () => {
    for (const custody of [
      undefined,
      {
        storage: "plaintext_file",
        credentials: [{ resource: "sheets.orders", kind: "oauth", revocation: "supported" }],
      } satisfies ConsentCustody,
      {
        storage: "plaintext_file",
        credentials: [{ resource: "sheets.orders", kind: "oauth", revocation: "unknown" }],
      } satisfies ConsentCustody,
    ]) {
      const rig = terminalRig();
      const p = rig.adapter.requestConsent(await request(custody), new AbortController().signal);
      await rig.waitFor(MAIN_QUESTION);
      rig.input.write("y\n");
      await expect(p).resolves.toEqual({ decision: "grant" });
      expect(rig.outText()).not.toContain(ACK_QUESTION);
    }
  });

  it("rejects on end of input during the acknowledgement, which core folds to decline", async () => {
    const rig = terminalRig();
    const p = rig.adapter.requestConsent(await request(unsupported), new AbortController().signal);
    const settled = p.then(
      (d) => d,
      (e: unknown) => e,
    );
    await rig.waitFor(MAIN_QUESTION);
    rig.input.write("y\n");
    await rig.waitFor(ACK_QUESTION);
    rig.input.end();
    expect(await settled).toBeInstanceOf(NoAnswerError);
  });

  it("folds an abort during the acknowledgement to a decline", async () => {
    const rig = terminalRig();
    const ac = new AbortController();
    const folded = awaitConsentDecision(rig.adapter, await request(unsupported), ac.signal);
    await rig.waitFor(MAIN_QUESTION);
    rig.input.write("y\n");
    await rig.waitFor(ACK_QUESTION);
    ac.abort();
    await expect(folded).resolves.toMatchObject({ decision: "decline" });
  });
});
