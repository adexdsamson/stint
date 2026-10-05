/**
 * Loads a lease's stored manifest through the ports and RE-VERIFIES it. The
 * stored bytes are never trusted on their own: a tampered artifact or a
 * publisher that is no longer trusted fails closed. Every failure is a
 * fixed-text `RuntimeError`; verification detail other than the spec error code
 * never reaches the message.
 */

import { parseEnvelope, verifyEnvelope } from "@stint/spec";
import type { VerifiedManifest } from "@stint/spec";

import { RuntimeError } from "./errors.js";
import type { RuntimePorts } from "./ports.js";

/** The artifact value as JSON text; a value that cannot be serialised becomes empty text, which then fails to parse. */
function serialize(value: unknown): string {
  try {
    // JSON.stringify yields undefined at runtime for a function or symbol, despite its string type.
    const text: unknown = JSON.stringify(value);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

export async function loadLeaseManifest(
  ports: Pick<RuntimePorts, "artifacts" | "trust">,
  leaseId: string,
): Promise<VerifiedManifest> {
  const stored = await ports.artifacts.get(leaseId, "envelope");
  if (stored === undefined) {
    throw new RuntimeError("manifest_invalid", "The lease has no stored manifest.");
  }
  const parsed = parseEnvelope(new TextEncoder().encode(serialize(stored)));
  if (!parsed.ok) {
    throw new RuntimeError("manifest_invalid", "The stored manifest could not be parsed.");
  }
  const verified = await verifyEnvelope(parsed.value, await ports.trust());
  if (!verified.ok) {
    const reason = verified.errors[0]?.code ?? "invalid_signature";
    throw new RuntimeError("manifest_invalid", `The stored manifest failed verification (${reason}).`);
  }
  return verified.value;
}
