/**
 * Fixed user-facing strings for credential custody and blocked teardown. Nothing
 * here interpolates a secret, a file's contents or upstream error text (the rule
 * in `exit.ts`): the only variable parts are a lease id that has already passed
 * `assertSafeLeaseId` and resource names that go through `sanitizeForTerminal`.
 */

import type { LeaseEndReason } from "@stint/runtime";
import type { TeardownStuckPayload } from "@stint/spec";

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

/**
 * The exit-8 message when another driver's teardown fence is still held after the
 * bounded wait (D-13, user resolution 5). Fixed text; `leaseId` is already validated.
 */
export function teardownBusyMessage(leaseId: string): string {
  return `Another process is tearing down this lease. Wait for it to finish, then run: stint-cli cleanup ${leaseId}`;
}

/** Shown once in the consent Credentials section when the lease will hold credentials (D-09). */
export const CONSENT_PLAINTEXT_LINE =
  "Credentials are stored unencrypted on this machine until the lease ends.";

/** Shown when at least one credential's revocation capability has not been checked yet (D-28). */
export const CONSENT_CAPABILITY_UNKNOWN_LINE =
  "Whether these credentials can be revoked is not yet known. It is checked when credentials are supplied.";

/** The question for the separate unrevocable-credential acknowledgement (D-15). */
export const UNREVOCABLE_ACK_QUESTION =
  "I understand this credential will not be revoked. Continue? [y/N] ";

/** The header of the unrevocable-credential acknowledgement. */
export const UNREVOCABLE_ACK_HEADER = "Credential that cannot be revoked";

/** One sentence per resource in the acknowledgement; the resource name is sanitized here. */
export function unrevocableSentence(resource: string): string {
  return `The credential for ${sanitizeForTerminal(resource)} cannot be revoked by Stint. It stays valid at the provider after the lease ends until you rotate it in the provider dashboard.`;
}

/**
 * The stderr notice `run` prints, when a credential first arrives, for one that
 * cannot be revoked upstream (D-15, D-28). It is a notice, not a prompt: under
 * `run` stdout is the MCP channel and a prompt would stop headless runs.
 */
export function unrevocableNotice(resource: string): string {
  return unrevocableSentence(resource);
}

/**
 * The one line `stint-cli run` prints, on stderr, when its lease ends and it stops serving (D-08).
 * Only the closed reason is interpolated; the caller adds the `stint: ` prefix.
 */
export function leaseEndedLine(reason: LeaseEndReason): string {
  return `Lease ended (${reason}); stopping.`;
}

/**
 * The line for a teardown that landed incomplete: shared by `revoke`, `cleanup` and a `run` that
 * ended its own lease. Only the validated lease id is interpolated; the caller adds the `stint: ` prefix.
 */
export function runTeardownUnfinishedLine(leaseId: string): string {
  return `Teardown did not finish. Run "stint-cli cleanup ${leaseId}" to resume it.`;
}

/** One `supervise` line when a sweep settled a lease past its expiry (D-20). Only the validated lease id is interpolated. */
export function sweepExpiredLine(leaseId: string): string {
  return `Lease ${leaseId} expired and was settled.`;
}

/** One `supervise` line when the provider revoked an idle lease's grant; the teardown line follows (SUP-04, D-17, D-20). Only the validated lease id is interpolated. */
export function sweepGrantRevokedLine(leaseId: string): string {
  return `Lease ${leaseId}: the provider revoked the grant; tearing the lease down.`;
}

/** One `supervise` line when a sweep finished a teardown; `label` is a closed state label from `stateLabel` (D-20, SPEC-07). */
export function sweepTornDownLine(leaseId: string, label: string): string {
  return `Lease ${leaseId} teardown finished: ${label}.`;
}

/** One `supervise` line for a supervisor retry of an incomplete teardown; `label` is a closed state label from `stateLabel` (D-04, D-20). */
export function sweepRetriedLine(leaseId: string, attempt: number, label: string): string {
  return `Lease ${leaseId} teardown retried (attempt ${String(attempt)}): ${label}.`;
}

/**
 * One `supervise` line when a lease is marked stuck: the closed reason and the exact
 * command that fixes it (D-04, D-20). The switch is exhaustive over the four reasons.
 */
export function sweepStuckLine(leaseId: string, reason: TeardownStuckPayload["reason"]): string {
  const head = `Lease ${leaseId} is stuck (${reason}). `;
  switch (reason) {
    case "credentials_unavailable":
      return `${head}Supply the credentials with: stint-cli cleanup ${leaseId} --credentials <file>`;
    case "retries_exhausted":
      return `${head}Check the trail with stint-cli receipts ${leaseId}, fix the cause, then run: stint-cli cleanup ${leaseId}`;
    case "revocation_failed":
      return `${head}The credential could not be revoked upstream. Rotate it in the provider dashboard, then run: stint-cli cleanup ${leaseId}`;
    case "manifest_invalid":
      return `${head}The stored manifest no longer verifies against your trust store. Restore the publisher key, then run: stint-cli cleanup ${leaseId}`;
  }
}

/** One `supervise` line for a lease record the store could not read (D-23). Never includes the record's contents. */
export function sweepCorruptLine(leaseId: string): string {
  return `Lease record ${leaseId} could not be read (store_corrupt); it was skipped and left unchanged.`;
}

/**
 * The no-echo prompt for one delegated API-key resource at `create` (10-02,
 * D-A). Fixed text; only the resource name is interpolated, sanitized here.
 * The answer is a SECRET: it is never echoed, logged or receipted.
 */
export function apiKeyPrompt(resource: string): string {
  return `Enter the API key for ${sanitizeForTerminal(resource)} (not shown as you type): `;
}

/**
 * The typed-entry prompt for one job parameter at `create` (10-05, SPEC-08).
 * Fixed text: the type is a closed enum value, the name is sanitized here,
 * and the description (publisher text) is sanitized. The value is NOT a
 * secret: the line says it will be shown at consent and bound to the lease,
 * so a user typing a secret into it sees that promise on the screen.
 */
export function jobParameterPromptLine(ask: {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly required: boolean;
  readonly invalidRetryMessage?: string;
}): string {
  const lines: string[] = [];
  if (ask.invalidRetryMessage !== undefined) lines.push(ask.invalidRetryMessage);
  if (ask.description !== undefined) lines.push(sanitizeForTerminal(ask.description));
  lines.push(
    `Enter the ${ask.type} value for ${sanitizeForTerminal(ask.name)}${ask.required ? "" : " (optional; press Enter to skip)"}; it will be shown at consent and bound to the lease: `,
  );
  return lines.join("\n");
}

/**
 * The fixed line shown before the single re-ask after an invalid answer
 * (10-05, SPEC-08). Only the closed type value names the expectation; the
 * answer itself is never echoed back.
 */
export function jobParameterInvalidMessage(type: string): string {
  const lines: Readonly<Record<string, string>> = {
    string: "That was not a valid string value (1 to 128 characters). Try again; a second invalid answer declines the lease.",
    integer: "That was not a valid integer value (whole kobo, at least 1). Try again; a second invalid answer declines the lease.",
    currency: "That was not a valid currency value (three uppercase letters, for example NGN). Try again; a second invalid answer declines the lease.",
  };
  return (
    lines[type] ??
    "That was not a valid value for this parameter. Try again; a second invalid answer declines the lease."
  );
}

/** One `supervise` line when a lease could not be processed. Never includes error text. */
export function sweepLeaseErrorLine(leaseId: string): string {
  return `Lease ${leaseId} could not be processed in this sweep.`;
}

/** One `supervise` line when a forward clock jump paused lease expiry; only the whole-second jump is interpolated (SUP-06, D-19, D-20). */
export function sweepClockPausedLine(jumpSeconds: number): string {
  return `The system clock jumped forward by ${String(jumpSeconds)} seconds; lease expiry is paused. If the clock is correct, run: stint-cli supervise --confirm-clock`;
}

/** One `supervise` line when the operator confirmed the clock and expiry resumed (SUP-06, D-19). */
export function sweepClockConfirmedLine(): string {
  return "Clock confirmed; lease expiry resumed.";
}

/** One `supervise` line when the clock pause marker cannot be read; expiry stays paused and the fix is named (SUP-06, T-09-49). */
export function sweepClockMarkerUnreadableLine(): string {
  return "The clock pause marker in the store could not be read, so lease expiry stays paused. If the system clock is correct, remove supervisor/clock-pause.json from the store.";
}

/** What `supervise --confirm-clock` prints after it wrote the confirmation (SUP-06, D-19). */
export function confirmClockDoneLine(): string {
  return "Clock confirmed. The supervisor resumes lease expiry on its next sweep.";
}

/** What `supervise --confirm-clock` prints when no pause is active; nothing is written (SUP-06). */
export function confirmClockNoPauseLine(): string {
  return "No clock pause is active.";
}

/** The fixed refusal when another supervisor holds the store lock (D-21, exit 8). */
export function supervisorBusyMessage(): string {
  return "Another supervisor is already running on this store.";
}

/** The fixed line when the supervisor lock is lost and the loop stops (D-21, exit 8). */
export function supervisorLockLostMessage(): string {
  return "The supervisor lock was lost; stopping.";
}

/** The fixed line when a whole sweep fails in the long-running mode; printed once per failure streak (D-20). */
export function sweepFailedLine(): string {
  return "The sweep could not read the store; it will try again at the next interval.";
}
