/**
 * The held-license custody guarantee (D-15, LIC-05 by construction).
 *
 * Mirrors `packages/spec/src/envelope.ts`'s `VerifiedManifest` brand: a
 * module-private `unique symbol` field means no object literal outside this
 * module can be assigned to `HeldLicense` without a type assertion, proved by
 * `held-license.test.ts`'s `@ts-expect-error`. `HeldLicense` goes one step
 * further than `VerifiedManifest`, though: it carries NO visible data fields
 * at all. The raw token string lives in a module-private `WeakMap`, keyed by
 * object identity, so `readLicenseToken` isn't merely the *documented* path
 * to the token -- it's the ONLY path. There is no public property a holder
 * could read directly even with a genuine instance in hand (proved by the
 * companion `@ts-expect-error` on `held.token` in the test file).
 *
 * `mintHeldLicense` is exported (not a true module-private function) because
 * both `license/issue.ts`'s callers and `@stint/core/testing`'s mock
 * `LicenseIssuer` need to mint one from a freshly signed token -- but a
 * `HeldLicense` minted this way still cannot be forged from outside this
 * package: constructing the brand field requires the `unique symbol`
 * declared below, which is never exported.
 */

declare const heldLicenseBrand: unique symbol;

/**
 * An opaque, minted-only handle around a raw PASETO license token. No
 * agent-facing, receipt-facing, or customer-resource-facing function may
 * accept or return this type except via {@link readLicenseToken} (D-15).
 */
export interface HeldLicense {
  readonly [heldLicenseBrand]: true;
}

/** Module-private: the only place a `HeldLicense`'s raw token is ever stored. */
const tokensByHandle = new WeakMap<HeldLicense, string>();

/**
 * Mints a frozen `HeldLicense` wrapping `token`. This is the only function
 * that can produce a genuine `HeldLicense` -- assigning an object literal to
 * the type is a compile error (the brand's `unique symbol` is never
 * exported), and a `HeldLicense` not minted here has no entry in
 * {@link tokensByHandle}, so {@link readLicenseToken} throws rather than
 * silently returning `undefined`.
 */
export function mintHeldLicense(token: string): HeldLicense {
  const held = Object.freeze({}) as HeldLicense;
  tokensByHandle.set(held, token);
  return held;
}

/**
 * The single narrow accessor to the raw token string (D-15). No other
 * exported function -- in this module or anywhere else in `@stint/core` --
 * returns the raw token from a `HeldLicense`.
 */
export function readLicenseToken(held: HeldLicense): string {
  const token = tokensByHandle.get(held);
  if (token === undefined) {
    throw new Error("readLicenseToken: value was not minted by mintHeldLicense.");
  }
  return token;
}
