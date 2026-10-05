/**
 * Fixed user-facing strings for credential custody and blocked teardown. Nothing
 * here interpolates a secret, a file's contents or upstream error text (the rule
 * in `exit.ts`): the only variable parts are a lease id that has already passed
 * `assertSafeLeaseId` and resource names that go through `sanitizeForTerminal`.
 */

import { sanitizeForTerminal } from "./adapter/sanitize.js";

/** Printed once, to stderr, by every command that writes a credential to the store (D-09). */
export const PLAINTEXT_WARNING =
  "Credentials for this lease are stored unencrypted on this machine until the lease ends.";

/** Appended on Windows, where no file mode protects the store (D-10). */
export const PLAINTEXT_WARNING_WINDOWS = "The file is protected only by your Windows user profile.";

/**
 * The exit-2 message for a cleanup whose recorded credentials are unavailable
 * (D-11, D-12, D-27). It names the missing resources and the one recovery command.
 */
export function blockedTeardownMessage(leaseId: string, resources: readonly string[]): string {
  const names = resources.map((resource) => sanitizeForTerminal(resource)).join(", ");
  return `Teardown is blocked: credentials for ${names} are not available. Supply them with: stint-cli cleanup ${leaseId} --credentials <file>`;
}
