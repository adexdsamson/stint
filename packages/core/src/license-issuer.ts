/**
 * `@stint/core/license-issuer` -- the test-runner-free subpath (D-14, Pitfall 5)
 * exposing the reference PASETO issuer a publisher wraps and the runtime-side
 * verify-then-mint client, plus PASERK `k4.public` import/export so a runtime
 * can pin a publisher's verification key from configuration. The public `.`
 * entry never re-exports these (D-07: `issueLicense`/`mintHeldLicense`/
 * `createMockLicenseIssuer` stay off the root).
 */

export {
  createReferenceLicenseIssuer,
  REFERENCE_LICENSE_ISSUER_KID,
} from "./license/reference-issuer.js";
export type {
  ReferenceLicenseIssuer,
  ReferenceLicenseIssuerOptions,
} from "./license/reference-issuer.js";
export {
  exportLicensePublicKey,
  importLicensePublicKey,
  isPublicPaserk,
} from "./license/public-key.js";
export { createLicenseIssuerClient } from "./license/license-issuer-client.js";
export type {
  LicenseIssuerClient,
  LicenseIssuerClientOptions,
  LicenseIssuerTransport,
  LicenseIssueRequest,
  LicenseReissueRequest,
} from "./license/license-issuer-client.js";
