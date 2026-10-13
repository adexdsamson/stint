import type { ConsentCustody, ConsentParameter } from "@stint/core";
import { resolveAuthMode } from "@stint/spec";
import type { Manifest } from "@stint/spec";

import {
  CONSENT_CAPABILITY_UNKNOWN_LINE,
  CONSENT_PLAINTEXT_LINE,
  UNREVOCABLE_ACK_HEADER,
  unrevocableSentence,
} from "../messages.js";
import { createStyle } from "../render/style.js";
import type { Style } from "../render/style.js";
import { sanitizeForTerminal } from "./sanitize.js";

/**
 * Renders the ALP section 6 consent summary as a sectioned, single-line-per-fact
 * string. Every manifest-derived value passes through `sanitizeForTerminal`
 * (T-06-09). Cleanup behaviour is labelled an attested publisher claim, never a
 * runtime-verified guarantee (section 6 / 13). The entered job parameters
 * (10-05, SPEC-08) render above the credentials block, in declaration order:
 * the user sees exactly the values that will bind, non-secret by design.
 */
export function renderConsent(
  manifest: Manifest,
  style: Style = createStyle(false),
  custody?: ConsentCustody,
  parameters?: readonly ConsentParameter[],
): string {
  const s = sanitizeForTerminal;
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push("", style.header(title));
  };
  const row = (text: string): void => {
    lines.push(`  ${text}`);
  };

  lines.push(style.header("Lease consent request"));

  section("Agent");
  row(`agent: ${s(manifest.agent.name)} (${s(manifest.agent.id)}) v${s(manifest.version)}`);
  if (manifest.agent.description !== undefined) row(`about: ${s(manifest.agent.description)}`);
  row(`publisher: ${s(manifest.publisher.name)} (${s(manifest.publisher.id)})`);
  row(`job: ${s(manifest.job.description)}`);
  row(`max lease duration: ${String(manifest.lease.max_duration_seconds)}s`);

  section("Scopes");
  for (const scope of manifest.scopes) {
    row(`${s(scope.resource)}: ${scope.access.map(s).join(", ")}`);
  }

  section("Limits");
  const { limits } = manifest;
  row(`max actions: ${String(limits.max_actions)}`);
  if (limits.actions_per_hour !== undefined)
    row(`actions per hour: ${String(limits.actions_per_hour)}`);
  if (limits.spend !== undefined) {
    row(
      `spend limit: ${String(limits.spend.amount_minor)} minor units of ${s(limits.spend.currency)}`,
    );
  }
  if (limits.error_threshold !== undefined) {
    row(
      `error threshold: ${String(limits.error_threshold.count)} errors in ${String(limits.error_threshold.window_seconds)}s`,
    );
  }

  section("Approvals");
  const required = manifest.approvals.require_for;
  row(`approval required for: ${required.length === 0 ? "(none)" : required.map(s).join(", ")}`);
  row(`approval timeout: ${String(manifest.approvals.timeout_seconds)}s (no answer means denied)`);

  section("Authentication");
  row(`auth mode: ${s(resolveAuthMode(manifest))}`);
  for (const grant of manifest.auth.delegated ?? []) {
    row(`delegated: ${s(grant.provider)} for ${grant.resources.map(s).join(", ")}`);
  }
  if (manifest.auth.hosted !== undefined) {
    row(`hosted license issuer: ${s(manifest.auth.hosted.license_issuer)}`);
  }

  if (parameters !== undefined && parameters.length > 0) {
    section("Job parameters");
    for (const parameter of parameters) {
      // The type is a closed enum, so it renders raw beside the sanitized name and
      // value (the credential-kind precedent below). The value is shown verbatim by
      // design: seeing what binds is the anti-phishing property (T-10-21).
      const value =
        typeof parameter.value === "number" ? String(parameter.value) : parameter.value;
      row(`${s(parameter.name)} (${parameter.type}): ${s(value)}`);
    }
  }

  if (custody !== undefined && custody.storage === "plaintext_file") {
    section("Credentials");
    for (const credential of custody.credentials) {
      const capability =
        credential.revocation === "supported"
          ? "can be revoked when the lease ends"
          : credential.revocation === "unsupported"
            ? "cannot be revoked by Stint"
            : "revocation not yet known";
      // The kind is a closed enum, so it renders raw beside the capability (SPEC-10, 10-02).
      row(`${s(credential.resource)} (${credential.kind}): ${capability}`);
    }
    row(CONSENT_PLAINTEXT_LINE);
    if (custody.credentials.some((credential) => credential.revocation === "unknown")) {
      row(CONSENT_CAPABILITY_UNKNOWN_LINE);
    }
  }

  section("Completion check");
  const verifier = manifest.job.verifier;
  row(`verifier: ${s(verifier.type)}`);
  if (verifier.type === "user_confirm") row(`you will be asked: ${s(verifier.prompt)}`);
  if (verifier.type === "resource_query")
    row(`queries: ${s(verifier.resource)} where ${s(verifier.predicate)}`);

  section("Cleanup");
  if (manifest.cleanup === null) {
    row("no publisher cleanup declared");
  } else {
    row(`cleanup hook: ${s(manifest.cleanup.hook.url)}`);
    row(
      `publisher retains: ${s(manifest.cleanup.publisher_retains)} ${style.attested("(attested publisher claim, not runtime-verified)")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Renders the separate acknowledgement for credentials Stint cannot revoke
 * (D-15, SPEC-07): a header and one fixed sentence per resource. Resource names
 * are sanitized; the sentence itself is fixed text.
 */
export function renderUnrevocableAcknowledgement(
  resources: readonly string[],
  style: Style = createStyle(false),
): string {
  const lines = [style.header(UNREVOCABLE_ACK_HEADER)];
  for (const resource of resources) lines.push(`  ${unrevocableSentence(resource)}`);
  return lines.join("\n");
}
