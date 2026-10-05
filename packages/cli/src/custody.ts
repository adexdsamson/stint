/**
 * Seeds the SecretStore from a parsed credentials file and tells the user, in the
 * same command, that the store keeps credentials unencrypted (D-06, D-09, D-10).
 *
 * The warning is one line on `deps.io.err`, printed only when something was
 * actually written, and there is no option, flag or environment variable that
 * suppresses it. It never carries a credential value.
 */

import type { SeededCredential } from "@stint/proxy";
import { seedLeaseCredentials } from "@stint/runtime";
import type { RuntimePorts, SeedResult } from "@stint/runtime";

import type { CliDeps } from "./deps.js";
import { PLAINTEXT_WARNING, PLAINTEXT_WARNING_WINDOWS } from "./messages.js";
import { toCliError } from "./runtime-errors.js";

export async function seedFromCredentials(
  deps: CliDeps,
  ports: RuntimePorts,
  leaseId: string,
  credentials: Readonly<Record<string, SeededCredential>>,
): Promise<SeedResult> {
  let result: SeedResult;
  try {
    result = await seedLeaseCredentials(ports, leaseId, credentials);
  } catch (error) {
    throw toCliError(error);
  }
  if (result.written.length > 0) {
    const windows = (deps.platform ?? process.platform) === "win32";
    deps.io.err(
      `stint: ${PLAINTEXT_WARNING}${windows ? ` ${PLAINTEXT_WARNING_WINDOWS}` : ""}\n`,
    );
  }
  return result;
}
