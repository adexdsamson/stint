import { describe, expect, it } from "vitest";

import type { HeldLicense } from "../../src/license/held-license.js";
import { mintHeldLicense, readLicenseToken } from "../../src/license/held-license.js";

describe("HeldLicense brand (D-15, LIC-05 by construction)", () => {
  it("a plain object literal is not assignable to HeldLicense", () => {
    // @ts-expect-error a plain object literal carries none of HeldLicense's
    // module-private unique-symbol brand field, which is never exported --
    // so no code outside held-license.ts can construct one without a type
    // assertion (enforced by `pnpm typecheck`).
    const fake: HeldLicense = {};

    // A value that was never minted has no entry in the module-private
    // WeakMap, so reading it throws rather than silently returning undefined.
    expect(() => readLicenseToken(fake)).toThrow();
  });

  it("HeldLicense exposes no public field -- readLicenseToken is the only accessor (type-level)", () => {
    const held = mintHeldLicense("v4.public.examplepayload");

    // @ts-expect-error HeldLicense carries no public data fields (only the
    // unexported brand symbol) -- `.token` does not exist on the type, so
    // the only way to read the wrapped string is through readLicenseToken.
    const attemptedDirectRead: unknown = held.token;

    expect(attemptedDirectRead).toBeUndefined();
  });

  it("mintHeldLicense + readLicenseToken round-trips the token", () => {
    const held = mintHeldLicense("v4.public.examplepayload");
    expect(readLicenseToken(held)).toBe("v4.public.examplepayload");
  });

  it("a minted HeldLicense is frozen and cannot be mutated after minting", () => {
    const held = mintHeldLicense("v4.public.examplepayload");
    expect(Object.isFrozen(held)).toBe(true);
  });

  it("readLicenseToken throws (does not return undefined) for a value not minted by mintHeldLicense", () => {
    const notMinted = {} as HeldLicense;
    expect(() => readLicenseToken(notMinted)).toThrow();
  });
});
