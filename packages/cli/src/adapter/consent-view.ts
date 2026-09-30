import { resolveAuthMode } from "@stint/spec";
import type { Manifest } from "@stint/spec";

import { createStyle } from "../render/style.js";
import type { Style } from "../render/style.js";
import { sanitizeForTerminal } from "./sanitize.js";

/**
 * Renders the ALP section 6 consent summary as a sectioned, single-line-per-fact
 * string. Every manifest-derived value passes through `sanitizeForTerminal`
 * (T-06-09). Cleanup behaviour is labelled an attested publisher claim, never a
 * runtime-verified guarantee (section 6 / 13).
 */
export function renderConsent(manifest: Manifest, style: Style = createStyle(false)): string {
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
