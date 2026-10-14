/**
 * `stint-cli verify-outcome <leaseId> [--profile <file>]` (CLI-03, Phase 10 D-E).
 *
 * The user-owned door to completion. It evaluates the lease's verifier through
 * `runOutcomeCheck` in `@stint/runtime` (the same function a live run's
 * `verifyOutcome()` uses): a `resource_query` verifier is read through the
 * connector and judged by code, a `user_confirm` verifier asks the user at the
 * terminal. A pass completes the lease through the existing receipted, fenced
 * path; a fail shows the verdict and changes nothing but one denied receipt.
 *
 * Exit codes reuse the existing vocabulary and invent none: pass 0, a failed
 * check `EXIT_CODES.wrongState` (9), a missing profile or a `none` verifier
 * usage (2), an unknown lease 4, a lease that is not active 9.
 *
 * Every printed line is fixed text. The only interpolated values are the lease
 * id, the lease state and the closed verdict enum: never a reference, an
 * amount, a key or upstream text. The `user_confirm` prompt waits with no lease
 * lock held, bounded by a deadline armed here.
 */

import { runOutcomeCheck } from "@stint/runtime";
import type { OutcomeCheckResult } from "@stint/runtime";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import {
  rotateCaveat,
  isUnrevokedCleanup,
  stateLabel,
  unrevokedResources,
} from "../render/caveat.js";
import {
  verifyOutcomeFailedLine,
  verifyOutcomeNeedsProfile,
  verifyOutcomeNoneVerifier,
  verifyOutcomeNotActive,
  verifyOutcomePassedLine,
  verifyOutcomeVerdictLine,
} from "../messages.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { loadRunProfile } from "../run/profile.js";
import { toCliError } from "../runtime-errors.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import { loadStoredManifest } from "../store/envelope.js";

export interface VerifyOutcomeOpts extends GlobalOpts {
  readonly profile?: string | undefined;
}

/** How long a `user_confirm` prompt waits when no consent timeout is injected, in seconds. */
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 120;

/** Runs the check with the deadline armed for the `user_confirm` prompt; the timer is always disposed. */
async function evaluate(
  deps: CliDeps,
  root: string,
  leaseId: string,
  json: boolean,
  profilePath: string | undefined,
  approvalTimeoutSeconds: number,
): Promise<OutcomeCheckResult> {
  const profile = profilePath === undefined || profilePath === "" ? undefined : await loadRunProfile(profilePath);
  const ports = buildRuntimePorts(deps, root);
  const adapter = deps.adapterFactory(deps.io, { json, approvalTimeoutSeconds });

  const controller = new AbortController();
  const timeoutSeconds = deps.consentTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutSeconds * 1000);
  try {
    return await runOutcomeCheck(ports, {
      leaseId,
      ...(profile === undefined ? {} : { profile }),
      adapter,
      signal: controller.signal,
      ...(deps.teardown?.decorateSteps === undefined
        ? {}
        : { decorateTeardownSteps: deps.teardown.decorateSteps }),
    });
  } catch (error) {
    throw toCliError(error);
  } finally {
    clearTimeout(timer);
    // Lets an adapter that is still prompting stop its own UI.
    controller.abort();
  }
}

export async function verifyOutcomeCommand(
  deps: CliDeps,
  leaseId: string,
  opts: VerifyOutcomeOpts,
): Promise<number> {
  assertSafeLeaseId(leaseId);
  const json = opts.json === true;
  const root = resolveStoreRoot(opts);

  const lease = await deps.storeFactory(root).load(leaseId);
  if (lease === undefined) throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  if (lease.state !== "active") throw new CliError(EXIT_CODES.wrongState, verifyOutcomeNotActive);

  // Refuse what cannot be evaluated before anything is read or prompted.
  const verified = await loadStoredManifest(deps, root, leaseId);
  const verifier = verified.manifest.job.verifier;
  if (verifier.type === "none") throw new CliError(EXIT_CODES.usage, verifyOutcomeNoneVerifier);
  if (verifier.type === "resource_query" && (opts.profile === undefined || opts.profile === "")) {
    throw new CliError(EXIT_CODES.usage, verifyOutcomeNeedsProfile);
  }

  const result = await evaluate(
    deps,
    root,
    leaseId,
    json,
    opts.profile,
    verified.manifest.approvals.timeout_seconds,
  );

  if (result.outcome === "true") {
    const unrevoked = isUnrevokedCleanup(result.lease)
      ? unrevokedResources(await deps.receiptStoreFactory(root, leaseId).load("verified"))
      : [];
    if (json) {
      deps.io.out(
        `${JSON.stringify({ leaseId, outcome: "verified", state: result.lease.state, unrevoked })}\n`,
      );
    } else {
      deps.io.out(`${verifyOutcomePassedLine(leaseId, stateLabel(result.lease))}\n`);
      for (const resource of unrevoked) deps.io.err(`stint: ${rotateCaveat(resource)}\n`);
    }
    return EXIT_CODES.ok;
  }

  const verdict = result.kind === "resource_query" ? result.verdict : undefined;
  if (json) {
    deps.io.out(
      `${JSON.stringify({ leaseId, outcome: "not_passed", ...(verdict === undefined ? {} : { verdict }) })}\n`,
    );
  } else {
    deps.io.err(
      `stint: ${verdict === undefined ? verifyOutcomeFailedLine(leaseId) : verifyOutcomeVerdictLine(leaseId, verdict)}\n`,
    );
  }
  return EXIT_CODES.wrongState;
}
