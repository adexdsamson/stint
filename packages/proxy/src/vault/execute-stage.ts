/**
 * `createVaultExecuteStage` -- the injection-without-exposure call site the
 * whole phase's secretless claim rests on (PRXY-06, LIC-05, D-01, D-02).
 * Implements the 04-02 `ExecuteStage` seam (`dispatch.ts`): resolves the
 * OAuth access token from the 04-05 `CredentialVault` (the ONLY token read
 * path -- `resolveAccessToken`), hands it to the injected, trusted
 * `OutboundConnector` port as `{ accessToken }`, and wraps the whole port
 * call in `vault/scrub.ts`'s scrubber so the exact resolved token cannot
 * survive into a returned value or a thrown error on its way back toward
 * `dispatch.ts`'s agent-facing boundary.
 *
 * The publisher license is NEVER read into the port's `credential` argument
 * here -- `credential` is `{ accessToken }` only, always. `licenseAccessor`
 * (a `HeldLicense`, read only via `@stint/core`'s `readLicenseToken`) is
 * accepted purely so a hosted/hybrid deployment's construction context can
 * carry a license for OTHER, publisher-facing logic outside this file; this
 * stage never reads it out and never threads it toward
 * `OutboundConnector.execute` (LIC-05, D-15).
 *
 * A `CredentialRefreshError` from the vault (`provider_revoked` /
 * `transient_error`, D-09) propagates unchanged -- this stage never
 * swallows it into a fabricated success; 04-07's revocation wiring is the
 * intended catch site.
 */

import type { HeldLicense } from "@stint/core";

import type { CallContext, ExecuteStage } from "../dispatch.js";
import type { OutboundConnector } from "../connectors/outbound-connector.js";
import type { CredentialVault } from "./credential-vault.js";
import { scrubCredential, scrubError } from "./scrub.js";

/**
 * Construction-time carrier for a hosted/hybrid deployment's publisher
 * license (D-15). Never read by `createVaultExecuteStage` itself -- present
 * only so callers can prove, by construction, that a license held in this
 * stage's context still never reaches `OutboundConnector.execute` (LIC-05).
 */
export interface LicenseAccessor {
  readonly license: HeldLicense;
}

/**
 * Constructs the real, vault-backed `ExecuteStage`. `vault` supplies the
 * single `resolveAccessToken` read path (D-04); `connector` is the injected
 * `OutboundConnector` port (D-01) -- never a concrete implementation
 * imported directly by this module. `licenseAccessor` is accepted and
 * otherwise unused by this stage (see module docstring).
 */
export function createVaultExecuteStage(
  vault: CredentialVault,
  connector: OutboundConnector,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted per LIC-05's construction-time-carrier contract (module docstring); intentionally never read here.
  licenseAccessor?: LicenseAccessor,
): ExecuteStage {
  return {
    async execute(
      ctx: CallContext,
      now: number,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      // The ONLY token read path (D-04) -- a failed refresh (D-09's
      // provider_revoked/transient_error) throws CredentialRefreshError,
      // which propagates unchanged past this function; it is never
      // swallowed into a stale/fabricated success.
      const accessToken = await vault.resolveAccessToken(ctx.leaseId, ctx.binding.resource, now);

      try {
        const result = await connector.execute(ctx.binding, ctx.resolvedArgs, { accessToken });
        // Success path: scrub the port's returned body before it can reach
        // dispatch.ts's `allowResult` -> agent-facing CallToolResult (D-02).
        return scrubCredential(result, [accessToken]);
      } catch (err) {
        // Failure path: scrub before rethrow, even though dispatch.ts's own
        // catch block already replaces any execute() error with a generic
        // "call failed" message toward the agent -- this is the
        // defense-in-depth scrub D-02 requires at the vault boundary
        // itself, independent of what dispatch.ts does with the result.
        throw scrubError(err, [accessToken]);
      }
    },
  };
}
