/**
 * `stint create <manifest-path>`: verify, consent, activate.
 *
 *   read -> parseEnvelope -> verifyEnvelope(trustStore) -> [publisher gate] ->
 *   [typed job-parameter entry] -> [API-key entry, no echo] -> renderConsent
 *   (via the adapter) -> awaitConsentDecision -> reduce(consentGranted) ->
 *   [bind jobParameters once] -> [issue license once] -> activateLease -> save
 *
 * Deny by default: an unparseable, tampered, or untrusted manifest fails
 * BEFORE any consent is shown, and every non-grant (decline, timeout, adapter
 * error, no TTY) leaves the lease `declined`. Every failure message is fixed
 * text; verification/jose error text and stacks are never printed.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  activateLease,
  awaitConsentDecision,
  clockEvents,
  credentialSecretKey,
  reduce,
  runtimeEvents,
  userEvents,
} from "@stint/core";
import type { ConsentParameter, Lease } from "@stint/core";
import {
  API_KEY_ORIGIN_UNRESOLVED,
  API_KEY_PROVIDERS,
  apiKeyOriginFor,
  delegatedApiKeyProviders,
} from "@stint/runtime";
import { MAX_ENVELOPE_BYTES, parseEnvelope, resolveAuthMode, verifyEnvelope } from "@stint/spec";
import type { Manifest } from "@stint/spec";

import { buildConsentCustody, grantsFromCustody, seedFromCredentials } from "../custody.js";
import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { apiKeyPrompt, jobParameterInvalidMessage } from "../messages.js";
import { resolveStoreRoot } from "../paths.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import type { JobParameterAsk } from "../run/job-parameters.js";
import {
  bindJobParameters,
  interpretJobParameterAnswer,
  orderParameterDeclarations,
} from "../run/job-parameters.js";
import { createPublisherClient, licenseClaimsFromManifest } from "../run/license-http.js";
import type { LoadedCredential } from "../run/credentials.js";
import { saveEnvelope } from "../store/envelope.js";
import { parsePublisherBindingFile, savePublisherBinding } from "../store/publisher-binding.js";
import type { PublisherBinding } from "../store/publisher-binding.js";

/** ASSUMED (A3): the manifest carries no consent timeout field; matches the terminal adapter's default. */
const DEFAULT_CONSENT_TIMEOUT_SECONDS = 120;

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The delegated resources that take an API key (their provider is in the
 * runtime's closed table) and that the credentials file does not already
 * cover (10-02, D-A): exactly the resources the prompt loop asks for, sorted
 * and de-duplicated. Fails with a fixed usage message before any prompt when
 * a table provider cannot be resolved (defensive; membership makes this
 * unreachable today).
 */
function apiKeyEntryResources(
  manifest: Manifest,
  credentials: Readonly<Record<string, LoadedCredential>> | undefined,
): readonly string[] {
  const providers = new Set(delegatedApiKeyProviders(manifest));
  for (const provider of providers) {
    if (API_KEY_PROVIDERS[provider] === undefined) {
      throw new CliError(
        EXIT_CODES.usage,
        "An API-key credential could not be resolved for a delegated resource.",
      );
    }
  }
  const names = new Set<string>();
  for (const grant of manifest.auth.delegated ?? []) {
    if (!providers.has(grant.provider)) continue;
    for (const resource of grant.resources) {
      if (credentials?.[resource] === undefined) names.add(resource);
    }
  }
  return [...names].sort(byName);
}

export interface CreateOpts extends GlobalOpts {
  readonly trust?: string | undefined;
  /** Publisher binding file (issue/reissue/invalidate URLs + license public key); required for hosted/hybrid. */
  readonly publisher?: string | undefined;
  /**
   * Credentials file (D-28). With it, consent can say which credentials cannot be
   * revoked, and the credentials are copied into the SecretStore after consent.
   */
  readonly credentials?: string | undefined;
  /**
   * Opt-in interactive API-key entry (D-A): with the flag, each delegated
   * resource whose provider takes an API key and is not already covered is
   * asked for once, no echo. Without the flag nothing is ever asked.
   */
  readonly apiKey?: boolean | undefined;
}

/** Reads the manifest file with a size cap applied BEFORE the bytes are loaded. */
async function readManifestBytes(file: string): Promise<Uint8Array> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new CliError(EXIT_CODES.usage, "The manifest file could not be read.");
  }
  if (size > MAX_ENVELOPE_BYTES) {
    throw new CliError(EXIT_CODES.manifestInvalid, "The manifest is too large.");
  }
  try {
    return await readFile(file);
  } catch {
    throw new CliError(EXIT_CODES.usage, "The manifest file could not be read.");
  }
}

function newLease(id: string, boundHash: string, maxDurationSeconds: number): Lease {
  return {
    id,
    state: "proposed",
    version: 0,
    boundHash,
    grantedAt: 0,
    expiresAt: 0,
    maxDurationSeconds,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
  };
}

export async function createCommand(
  deps: CliDeps,
  manifestPath: string,
  opts: CreateOpts,
): Promise<number> {
  const root = resolveStoreRoot(opts);
  const json = opts.json === true;

  // 1. Parse. `parseEnvelope` can throw on invalid UTF-8; that is a rejection, not a crash.
  const bytes = await readManifestBytes(manifestPath);
  let parsed: ReturnType<typeof parseEnvelope>;
  try {
    parsed = parseEnvelope(bytes);
  } catch {
    throw new CliError(EXIT_CODES.manifestInvalid, "The manifest could not be parsed.");
  }
  if (!parsed.ok) {
    throw new CliError(EXIT_CODES.manifestInvalid, "The manifest could not be parsed.");
  }

  // 2. Verify against the trust store BEFORE any consent (T-06-12). The reason
  // is a member of the fixed SPEC_ERROR_CODES vocabulary, never upstream text.
  const trustStore = await deps.loadTrustStore(root, { trust: opts.trust });
  const verified = await verifyEnvelope(parsed.value, trustStore);
  if (!verified.ok) {
    const reason = verified.errors[0]?.code ?? "invalid_signature";
    throw new CliError(EXIT_CODES.manifestInvalid, `The manifest failed verification (${reason}).`);
  }
  const manifest = verified.value.manifest;

  // 3. Hosted/hybrid activation needs a publisher to issue the license (D-14, D-18). The
  // binding is required and validated BEFORE any consent so a missing or malformed one
  // never costs the user a prompt.
  let binding: PublisherBinding | undefined;
  if (resolveAuthMode(manifest) !== "delegated") {
    if (opts.publisher === undefined || opts.publisher === "") {
      throw new CliError(
        EXIT_CODES.usage,
        "A lease with hosted or hybrid auth requires --publisher <file>.",
      );
    }
    binding = await parsePublisherBindingFile(opts.publisher);
  }

  // Credentials file (D-28): parsed BEFORE consent so a malformed file never costs the user a
  // prompt. Nothing is written to the store until consent has been granted (T-08-55).
  const credentials =
    opts.credentials !== undefined && opts.credentials !== ""
      ? await deps.credentials.load(opts.credentials)
      : undefined;

  // 4. Ensure the runtime signing key exists (created on first create, A4).
  await deps.keys.loadOrCreate(root);

  const now = deps.clock();
  const leaseId = randomUUID();
  const proposed = newLease(
    leaseId,
    verified.value.contentHash,
    manifest.lease.max_duration_seconds,
  );
  const store = deps.storeFactory(root);
  const ports = buildRuntimePorts(deps, root, { trust: opts.trust });

  /** Saves the lease as declined and fails with the fixed consent-declined message (exit 3). */
  const declineLease = async (): Promise<never> => {
    const declined = reduce(proposed, userEvents.consentDeclined(), now);
    if (!declined.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
    await store.save(declined.value.lease);
    throw new CliError(
      EXIT_CODES.consentDeclined,
      "Consent was not granted; no lease was activated.",
    );
  };

  /**
   * One no-echo ask for an API key, with a single re-ask on an empty or
   * whitespace answer (T-10-08). An explicit refusal (a second empty answer)
   * declines the lease: the user asked for key entry and then refused it, so
   * the credential is refused, never fabricated. No answer at all (no
   * terminal, EOF, abort, timeout) is no entry, not a refusal: that resource
   * simply proceeds without an API key and consent shows it honestly. The
   * resolved value is a SECRET and goes nowhere but the returned string.
   */
  const askApiKey = async (
    ask: NonNullable<CliDeps["askSecret"]>,
    resource: string,
  ): Promise<string | undefined> => {
    const prompt = apiKeyPrompt(resource);
    let answer = await ask(prompt);
    if (answer === undefined) return undefined;
    if (answer.trim() === "") {
      answer = await ask(prompt);
      if (answer === undefined) return undefined;
      if (answer.trim() === "") return await declineLease();
    }
    return answer.trim();
  };

  // Typed parameter entry (10-05, SPEC-08), BEFORE the API-key prompt and consent: for
  // each declaration, in manifest order, the user types the job's fixed inputs. The
  // values are not secrets; each is shown on the consent screen and bound once, at
  // activation. An unanswered ask (no terminal, EOF, abort) or a second invalid answer
  // declines the lease: an empty answer is the explicit skip for an optional parameter,
  // never a value, and the job cannot run honestly without the inputs its publisher
  // declared. No seam means no terminal, which declines the same way.
  const declarations = orderParameterDeclarations(manifest.job.parameters);
  const enteredValues: Record<string, string | number> = {};
  if (declarations.length > 0) {
    const askParameter = deps.askJobParameter;
    if (askParameter === undefined) return await declineLease();
    for (const declaration of declarations) {
      let interpreted = interpretJobParameterAnswer(declaration, await askParameter(declaration));
      if (interpreted.kind === "invalid") {
        // One re-ask with the fixed invalid-value line, then a decline (T-10-21: the
        // re-ask shows the expectation; the answer itself is never echoed back).
        const retry: JobParameterAsk = {
          ...declaration,
          invalidRetryMessage: jobParameterInvalidMessage(declaration.type),
        };
        interpreted = interpretJobParameterAnswer(declaration, await askParameter(retry));
      }
      if (interpreted.kind === "declined" || interpreted.kind === "invalid") {
        return await declineLease();
      }
      if (interpreted.kind === "value") enteredValues[declaration.name] = interpreted.value;
    }
  }

  // Opt-in API-key entry (10-02, D-A), BEFORE consent and only under --api-key: each
  // delegated resource that takes an API key and is covered by neither the credentials
  // file nor the store is asked for exactly once. Without the flag nothing is ever
  // asked, so every pre-existing flow (OAuth grants arriving later, headless creates)
  // behaves exactly as before. A host with no secret channel (no askSecret seam) or an
  // unanswered ask skips that resource: CRED-01 lets a user provide a key, it never
  // demands one. A credential the store already holds is never re-asked
  // (put-if-absent end to end). The value stays in this map until seeding, after
  // activation, stores it at its hashed path; nothing else ever sees it.
  const ask = opts.apiKey === true ? deps.askSecret : undefined;
  const entered: Record<string, Extract<LoadedCredential, { kind: "api_key" }>> = {};
  if (ask !== undefined) {
    for (const resource of apiKeyEntryResources(manifest, credentials)) {
      if ((await ports.secrets.get(credentialSecretKey(leaseId, resource))) !== undefined) continue;
      const key = await askApiKey(ask, resource);
      if (key === undefined) continue;
      entered[resource] = { kind: "api_key", key };
    }
  }

  // Consent sees the union of the file entries and the entered API keys, so the screen
  // shows each credential's kind and revocation capability (SPEC-10); no secret value
  // crosses into the custody object.
  const seededCredentials: Record<string, LoadedCredential> = { ...(credentials ?? {}), ...entered };
  // Origin pinning (10-03, CRED-02, D-B): every API key is bound at seed time to exactly one
  // origin (its own entry, else the closed provider table). One that resolves to none is
  // refused here, before consent, with fixed text: nothing is shown, written or activated.
  // (`create` holds no run profile, so a profile `providerOrigins` override only applies at `run`.)
  for (const [resource, credential] of Object.entries(seededCredentials)) {
    if (
      credential.kind === "api_key" &&
      credential.origin === undefined &&
      apiKeyOriginFor(manifest, resource) === undefined
    ) {
      throw new CliError(EXIT_CODES.usage, API_KEY_ORIGIN_UNRESOLVED);
    }
  }
  const custody = buildConsentCustody(manifest, seededCredentials);

  // The consent screen shows exactly what will bind, in declaration order (SPEC-08):
  // one `name (type): value` row per entered parameter. Optionals the user skipped
  // are omitted; a manifest with nothing bound carries no parameters at all.
  const consentParameters: ConsentParameter[] = [];
  for (const declaration of declarations) {
    const value = enteredValues[declaration.name];
    if (value !== undefined) {
      consentParameters.push({ name: declaration.name, type: declaration.type, value });
    }
  }

  // 5. Consent, with the timeout armed here and the outcome decided by core.
  const adapter = deps.adapterFactory(deps.io, {
    json,
    approvalTimeoutSeconds: manifest.approvals.timeout_seconds,
  });

  const controller = new AbortController();
  const timeoutSeconds = deps.consentTimeoutSeconds ?? DEFAULT_CONSENT_TIMEOUT_SECONDS;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutSeconds * 1000);
  let decision: Awaited<ReturnType<typeof awaitConsentDecision>>;
  try {
    decision = await awaitConsentDecision(
      adapter,
      {
        consentId: randomUUID(),
        manifest: verified.value,
        custody,
        ...(consentParameters.length === 0 ? {} : { parameters: consentParameters }),
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
    // Lets an adapter that is still prompting stop its own UI.
    controller.abort();
  }

  if (decision.decision !== "grant") {
    const event =
      decision.reason === "timeout" ? clockEvents.consentTimedOut() : userEvents.consentDeclined();
    const declined = reduce(proposed, event, now);
    if (!declined.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
    await store.save(declined.value.lease);
    throw new CliError(
      EXIT_CODES.consentDeclined,
      "Consent was not granted; no lease was activated.",
    );
  }

  // 6. Grant -> [issue the license once] -> activate. The bound-hash guard lives inside
  // activateLease (D-21).
  const granted = reduce(proposed, userEvents.consentGranted(), now);
  if (!granted.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");

  // The license is an activation guard (ALP 7.4, D-18): issued once here, verified against
  // the pinned publisher key, then dropped -- `run` re-issues for custody. Any failure
  // (unreachable, refused, unverifiable) fails activation with a FIXED message; the
  // publisher's response and the token are never echoed.
  if (binding !== undefined) {
    try {
      const client = await createPublisherClient(binding, manifest.spec_version);
      await client.issue(
        licenseClaimsFromManifest(granted.value.lease.id, manifest),
        now,
        granted.value.lease.expiresAt,
      );
    } catch {
      const failed = reduce(granted.value.lease, runtimeEvents.activationFailed(), now);
      if (!failed.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
      await store.save(failed.value.lease);
      throw new CliError(
        EXIT_CODES.wrongState,
        "The publisher did not issue a verifiable license; no lease was activated.",
      );
    }
  }

  // Write-once parameter binding (10-05, SPEC-08): re-validate the entered values
  // against the declarations (an unreachable-by-UI defense; the entry loop already
  // parsed each answer) and attach them to the record being activated. This is the
  // ONLY write to jobParameters anywhere: no command, tool call or verifier read can
  // update the field afterwards. An all-skipped optional set binds nothing.
  const boundParameters = bindJobParameters(declarations, enteredValues);
  if (boundParameters === undefined) throw new CliError(EXIT_CODES.internal, "Internal error.");
  const activating: Lease =
    Object.keys(boundParameters).length === 0
      ? granted.value.lease
      : { ...granted.value.lease, jobParameters: boundParameters };

  const activated = activateLease(activating, verified.value, now);
  if (!activated.ok) throw new CliError(EXIT_CODES.internal, "Internal error.");
  const lease = activated.value.lease;
  await store.save(lease);
  if (lease.state !== "active") {
    throw new CliError(EXIT_CODES.wrongState, "The lease could not be activated.");
  }
  // The lease carries only the bound hash; keep the signed envelope beside it so
  // `run`/`revoke`/`cleanup` can re-verify it and read scopes, limits and auth mode.
  await saveEnvelope(root, lease.id, parsed.value);
  // Hosted/hybrid: keep the non-secret publisher binding beside the lease so `run`,
  // `revoke` and `cleanup` can reach the publisher without further flags.
  if (binding !== undefined) await savePublisherBinding(root, lease.id, binding);

  // Record what this lease is expected to hold so teardown can fail closed, then copy any
  // supplied or interactively entered credentials into the store. Both happen only now,
  // after consent and activation.
  await ports.artifacts.put(lease.id, "grants", grantsFromCustody(custody));
  if (Object.keys(seededCredentials).length > 0) {
    await seedFromCredentials(deps, ports, lease.id, seededCredentials, { manifest });
  }

  if (json) {
    deps.io.out(
      `${JSON.stringify({ leaseId: lease.id, state: lease.state, expiresAt: lease.expiresAt })}\n`,
    );
  } else {
    deps.io.out(`${lease.id}\n`);
    deps.io.err(
      `stint: lease active until ${new Date(lease.expiresAt * 1000).toISOString()}. Inspect it with: stint-cli inspect ${lease.id}\n`,
    );
  }
  return EXIT_CODES.ok;
}
