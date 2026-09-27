# Pitfalls Research

**Domain:** Agent authorization runtime / MCP proxy / OAuth-for-agents / PASETO licensing / tamper-evident audit log
**Researched:** 2026-09-27
**Confidence:** MEDIUM (cross-checked web sources + official RFC/spec text; no project-specific production incidents to draw on since this is greenfield)

## Critical Pitfalls

### Pitfall 1: Tool binding trusted from the wrong source (publisher-supplied instead of runtime-owned)

**What goes wrong:**
If the mapping from an MCP tool name to `(resource, access, irreversible)` is ever derived from data the publisher controls (the manifest, or worse, live tool descriptions fetched from the MCP server at call time), a malicious or compromised publisher can label a `pay` or `write` operation as `read`, or silently change the mapping after the user approved the lease ("rug pull"). This is the MCP tool-poisoning and rug-pull class of attack: a tool's description or behavior looks safe at approval time and is mutated afterward, and the model reading the description has no incentive to flag the change to the user.

**Why it happens:**
It is tempting to let the manifest declare its own scopes because it is convenient and publishers "should" know their own tool's effects. Convenience creates a self-attestation loophole — deny-by-default is undermined if the party being denied gets to define the categories.

**How to avoid:**
Stint's design already places connector bindings in runtime-owned code, never the manifest — keep this invariant absolute, including for "custom" bindings, which must go through explicit user approval, not automatic manifest ingestion. Enforce a rule in code review / CI: nothing in `@stint/proxy` may read scope/access-level fields out of the publisher manifest for enforcement decisions; the manifest may only be used for display/audit, never for authorization. Add a bound manifest content hash at consent time (already planned) so any manifest change after consent — even to *non-enforced* fields like description text — is detectable as a mismatch and forces re-consent rather than silent drift.

**Warning signs:**
- Any code path in the proxy that reads `access` or `resource` from manifest JSON rather than from the connector binding registry.
- Tests that pass a manifest claiming `read` for a call the binding registry maps to `write`/`pay`, and the proxy allows it.
- No re-validation of manifest hash on lease resume/refresh.

**Phase to address:** proxy (enforcement), spec (normative rule that bindings are runtime-owned, never publisher-declared).

---

### Pitfall 2: Confused deputy via token passthrough at the MCP boundary

**What goes wrong:**
The MCP spec explicitly forbids token passthrough — an MCP server forwarding the client's/user's token as-is to a downstream API — because it collapses two distinct trust boundaries into one: the boundary between "user consented to this specific proxy" and "downstream API trusts this bearer token for anything it's scoped to." If Stint's proxy or connector code ever hands the agent (or lets the agent's MCP client directly negotiate) a real, unscoped credential for Paystack/Sheets/etc., a prompt-injected agent inherits the full blast radius of that credential, not just the leased scope.

**Why it happens:**
It's the path of least resistance: OAuth libraries hand you a bearer token, and forwarding it directly to the resource server "just works" in a demo. The confused-deputy failure only shows up once a second, less-trusted party (the agent, or a compromised MCP server) is in the loop and can trigger the proxy to act with more authority than the immediate request should carry.

**How to avoid:**
Stint's design decision "license never forwarded to customer resources" already encodes the right answer for the license leg. Extend the same discipline to delegated OAuth: the agent/model never sees the raw access token; the proxy holds it and performs the call itself after checking the lease. Verify this at the type level — the `HostAdapter`/agent-facing surface should have no method that returns a bearer token, only "execute this bound tool call." Add a specific test: attempt to have the agent-facing interface return or leak a credential string, and assert it's impossible by construction (not just by convention).

**Warning signs:**
- Any function signature that returns an `access_token` string to code outside `@stint/proxy`'s trusted boundary.
- Connector bindings that accept a token parameter from the caller rather than fetching it themselves from the credential store.

**Phase to address:** proxy (execution boundary), core state machine (credential custody model).

---

### Pitfall 3: TOCTOU between approval and execution — args, binding, or lease state drift

**What goes wrong:**
A human approves a tool call by looking at a rendered summary of arguments. If anything between "approval granted" and "call executed" can change — the args get rewritten by a downstream hook, the lease's scope was mutated concurrently, or the binding registry itself was hot-reloaded — the thing that executes is not the thing that was approved. This is a general TOCTOU class, and it has already bitten real agent-approval systems (e.g., an approver sees the model's original tool arguments while a post-validation hook silently transforms them before dispatch).

**Why it happens:**
Approval and execution are naturally separated by at least one async hop (out-of-band HostAdapter approval, per Stint's design), and it's easy to treat "approved: true" as a boolean flag rather than a binding commitment to specific bytes.

**How to avoid:**
Never approve "a tool call" in the abstract — approve a content-addressed request: hash the exact resolved arguments (post any redaction/canonicalization) plus the binding version plus the lease version, and require that exact hash to match at execution time. If the hash doesn't match — because the model changed its mind about args, a binding was updated, or the lease was modified mid-flight — treat it as a *new* request requiring new approval, never a silent re-use of the old approval. Since Stint enforces expiry per call rather than by timer (already decided), add the same per-call re-check for "does this exact call still fall within what was approved," not just "is the lease still active."

**Warning signs:**
- Approval records that store only a boolean or a call name, not the concrete argument hash.
- Any retry logic that re-dispatches a previously approved call with regenerated arguments.
- Gap between "approval granted" and "call executed" with no re-validation step in between.

**Phase to address:** proxy (approval-to-execution binding), core state machine (what an approval record actually commits to).

---

### Pitfall 4: PASETO implicit assertions and footer misuse silently breaking or weakening verification

**What goes wrong:**
Two related PASETO footguns:
1. **Implicit assertions** (v3/v4) are authenticated but never stored in the token — the verifier must independently reconstruct the exact same assertion value used at signing time, or verification fails with an opaque error indistinguishable from "token forged." If Stint binds implicit assertions to e.g. `lease_id`, and the runtime and the license-issuance code compute that value even slightly differently (different serialization, different field order, stale lease_id), every license silently fails to verify — or worse, if implicit assertions are *not* used where they should be, a license issued for one context can be replayed in another.
2. **Footer** is authenticated but NOT encrypted — anything placed there (including in v4.local) is readable by anyone holding the token. Putting anything sensitive in the footer (e.g., raw customer identifiers, internal routing hints) leaks it to the agent/publisher/any party that ends up holding the license token.

**Why it happens:**
Implicit assertions look like "just another field" until you realize they're not serialized in the token and thus require perfectly matched out-of-band derivation. Footers look like "free extra space" and get used for convenience data without considering that PASETO's local mode encrypts the payload but never the footer.

**How to avoid:**
Document explicitly in `@stint/core license` what implicit assertion value is used (e.g., `lease_id` + `spec_version`) and pin it in one shared function used by both issuance and verification — never hand-recompute it in two places. Footer contents are audited as "public, non-secret, integrity-protected only" — put `kid` (key id) and non-sensitive routing there, nothing else. Because Stint uses v4.public (asymmetric, publisher-signed), also confirm clock-skew tolerance is explicitly configured (most libraries default to zero tolerance) given the design's tight 5-minute TTL default — a few seconds of clock drift between publisher and runtime could cause spurious expiry right at the boundary that revocation latency depends on.

**Warning signs:**
- Implicit assertion construction logic duplicated (even slightly differently) in issuance vs. verification code paths.
- Any field placed in the footer that would be a problem if read by the agent or an intermediary.
- No explicit `clockTolerance`/skew config, especially given the 5-minute default TTL is itself a tight budget.

**Phase to address:** core license (PASETO issuance/verification), spec (define implicit assertion contract normatively).

---

### Pitfall 5: Revocation that returns success but did nothing (OAuth RFC 7009 silent no-op)

**What goes wrong:**
RFC 7009 mandates that a revocation endpoint return success even for tokens it doesn't recognize, doesn't support revoking, or has already expired — "the purpose of the request is already achieved." This means a `200 OK` from a provider's revoke endpoint is *not* proof the credential was actually invalidated. Stint's design already anticipates this for provider-side revocation (`revoked | discarded_revocation_unsupported | failed`), but the same trap applies anywhere the codebase is tempted to treat an HTTP success as ground truth: the license revocation endpoint, the cleanup hook's own acknowledgment, or a downstream connector's "disconnect" call.

**Why it happens:**
HTTP 200 is such a strong conventional signal of "it worked" that it's easy to build teardown logic that stops verifying once it sees success, especially under time pressure to make teardown feel instant.

**How to avoid:**
Never infer "credential is actually dead" purely from a 2xx revoke response. Where possible, positively confirm dead credentials (a subsequent authenticated call returns 401/invalid_grant) rather than trusting the revoke call alone. For providers with no RFC 7009 support (this is common — the RFC doesn't mandate implementation, only defines the shape if present), explicitly record `discarded_revocation_unsupported` as a distinct, non-silent state in the receipt, so the plain-language timeline can honestly say "we discarded our copy of this credential; we could not confirm the provider revoked it," rather than implying revocation succeeded. Detect customer-side revocation lazily (already planned: `invalid_grant`/401) and make sure that detection path also updates receipts, not just silently degrades functionality.

**Warning signs:**
- Teardown code path that marks a credential `revoked` purely because the revoke HTTP call returned 2xx, with no distinction for providers known not to support RFC 7009.
- No receipt entry differentiating "confirmed revoked" from "revocation attempted, provider gave no real signal."

**Phase to address:** core receipts (revocation result taxonomy), teardown orchestrator.

---

### Pitfall 6: Refresh token rotation race causing spurious full-family revocation

**What goes wrong:**
With refresh-token rotation (recommended by OAuth 2.1), if two code paths (e.g., a proactive background refresh and a just-in-time refresh triggered by an expired-token 401) both race to redeem the same refresh token, the loser presents an already-consumed token. Reuse-detection providers (Okta, Auth0, Google, Microsoft, etc.) cannot distinguish an honest race from a stolen-token replay attack, and will revoke the *entire* token family — logging the whole delegated grant out, which for Stint means the entire lease's OAuth leg dies for a reason that had nothing to do with the user, the agent, or an actual security event.

**Why it happens:**
Refresh logic is often written assuming single-threaded, single-caller access to the refresh token, but a runtime proxying many tool calls concurrently will naturally have concurrent triggers for "is this token about to expire, refresh it."

**How to avoid:**
Serialize refresh-token redemption per credential behind a single in-process (and, if the LeaseStore is ever shared across processes, cross-process) lock/mutex — never let two concurrent call paths both attempt to redeem the same refresh token. Treat "refresh in flight" as a state: callers that arrive while a refresh is pending should await the in-flight refresh's result rather than starting their own. This is a natural fit for the state-machine discipline the project already has for leases — apply the same rigor to the refresh sub-state.

**Warning signs:**
- Refresh logic triggered independently from multiple call sites (e.g., both a timer and a 401-handler) without a shared "refresh in progress" guard.
- No test that fires two concurrent tool calls against a token that's about to expire and asserts only one refresh request hits the provider.

**Phase to address:** proxy (credential refresh path), core state machine (refresh-in-flight sub-state).

---

### Pitfall 7: Hash-chain receipts broken by non-canonical serialization or unanchored heads

**What goes wrong:**
Two distinct failure modes for the append-only hash-chained receipt log:
1. **Non-canonical serialization**: if the bytes hashed for each receipt aren't a strictly canonical form (sorted object keys, fixed number representation, fixed encoding of `undefined`/optional fields), the *same logical receipt* can hash differently depending on which code path produced it (e.g., different Node versions, different JSON.stringify key ordering after an object is rebuilt from a Map vs. a plain object literal), making legitimate old entries look tampered on re-verification, or worse, making genuinely different content collide in how it's compared.
2. **Unanchored head / truncation**: a hash chain only proves *internal* consistency — it cannot on its own prove the chain hasn't been wholesale truncated and restarted, or replaced with a shorter, internally-consistent prefix, by anyone with write access to the store. Since Stint explicitly signs chain checkpoints (Ed25519) to address this, the pitfall is checkpoint *frequency and anchoring*: if checkpoints are infrequent, or only stored alongside the chain itself (not exported/mirrored anywhere), a full compromise of the store can roll back to right before the last checkpoint and there is no external witness to catch it.

**Why it happens:**
Canonical serialization is invisible until cross-environment or cross-version verification is actually attempted — it's easy to ship a hash-chain implementation that works fine because it's always the same process writing and reading. Checkpoint anchoring is deprioritized because "we already sign the checkpoint" feels sufficient until you ask "signed and stored where, readable by whom."

**How to avoid:**
Define one canonical serialization function (sorted keys, fixed number formatting, explicit handling of the args-hash + binding-redacted-summary fields already planned) and make every hash computation — verified chain, attested chain, checkpoint — go through that single function, never ad hoc `JSON.stringify`. Add a cross-version/cross-environment test: serialize a fixed fixture receipt and assert the hash is byte-identical to a hardcoded expected value, so any future serialization drift is caught immediately, not discovered during an audit dispute. For checkpoints, treat "signed but only stored next to the chain it protects" as equivalent to unsigned for the truncation-attack scenario — the CLI's receipt-printing path should support exporting/pinning a checkpoint externally (e.g., printed to the user, or written to a separate file) so a wholesale store compromise is independently detectable. Also decide and document behavior for unclean shutdown mid-append (crash between write and chain-head update) — a torn write must be distinguishable from tampering, not conflated with it.

**Warning signs:**
- More than one place in the codebase computing a receipt hash, or any use of raw `JSON.stringify` on receipt objects without a canonicalization step first.
- No fixture-based golden-hash test for the receipt format.
- Checkpoints signed but never surfaced/exported anywhere outside the store file itself.
- No test that simulates a crash mid-append and verifies the recovery path doesn't silently drop or duplicate the last entry.

**Phase to address:** core receipts (hash chain implementation, canonical serialization, checkpoint anchoring), cli (checkpoint export/print).

---

### Pitfall 8: Secrets leaking through error paths and receipts, not just logs

**What goes wrong:**
The obvious "don't log secrets" rule is well understood, but the higher-risk leak surface for Stint specifically is: (a) error messages bubbled up from OAuth/PASETO libraries that embed the raw token/credential in the exception text (common in HTTP client libraries that stringify the full request including `Authorization` headers on failure), and (b) the receipt log itself — which is *designed* to be durable, shareable, and displayed — accidentally including raw args instead of the args hash + redacted summary the design already calls for. A receipt is worse than a log line to leak into, because receipts are meant to be retained and shown to users/auditors.

**Why it happens:**
Library-level error objects often include the full request/response for debuggability, and it's easy for a `catch` block to log or store `error.message` or `error.toString()` without checking what the underlying HTTP client put in there. Redaction is also usually applied as a formatting step at the log sink, which receipts (structured, hash-chained, signed) don't go through the same way.

**How to avoid:**
Treat this as two separate controls, not one: (1) a hard rule that any error caught from OAuth/HTTP/PASETO library calls is re-thrown as a sanitized internal error type with a fixed, non-interpolated message before it can reach any logging or receipt path — never pass library exceptions through unmodified; (2) enforce at the type level that the receipt-writing function's input type has no field capable of holding raw args (only `argsHash: string` and `redactedSummary: string`), so it's a compile error, not a code-review catch, to accidentally pass raw args into a receipt. Add a test that deliberately triggers an OAuth failure with a token in the request and asserts the resulting receipt/log contains no substring of that token.

**Warning signs:**
- Any `catch (e) { log(e.message) }` or similar pattern around OAuth/PASETO/HTTP calls without an intermediate sanitization step.
- Receipt-writer function signature that accepts a generic `args: unknown` or `args: Record<string, any>` rather than only the hash/summary shape.
- No test asserting a known secret value never appears anywhere in a produced receipt or log line.

**Phase to address:** core receipts (redaction contract, receipt input type), proxy (error sanitization at the OAuth/connector boundary).

---

### Pitfall 9: Windows JSON-store atomicity failing exactly where correctness matters most (teardown)

**What goes wrong:**
The standard "write to temp file, then rename over the target" pattern for atomic JSON writes is not fully atomic on Windows the way it is on POSIX: `fs.rename` can fail with `EPERM`/`EBUSY` when the target file is transiently held open by another process (antivirus scanning it, a search indexer, or even another Node process/thread reading the store concurrently). Since the developer is on Windows and this is a stated cross-platform constraint, a naive `write-file-atomic`-style implementation without retry logic will produce intermittent, hard-to-reproduce failures — and the worst time for this to happen is during teardown, where a half-written lease store could leave a lease looking `active` when credentials have already been revoked, or vice versa.

**Why it happens:**
POSIX rename-is-atomic is a deeply ingrained assumption in the Node ecosystem (most "atomic JSON store" tutorials/libraries are written and tested on POSIX first), and Windows-specific file-locking behavior only shows up under real-world conditions (AV software, concurrent CLI + running lease, etc.) rather than in a quick local test.

**How to avoid:**
Use a maintained atomic-write implementation that already handles Windows retry semantics (e.g., `write-file-atomic`, which has known issues but active retry logic) rather than hand-rolling temp-then-rename, and explicitly configure retry with backoff (a few attempts, tens to low-hundreds of ms) on `EPERM`/`EBUSY`/`EACCES`. Since this is default `LeaseStore` behavior and the interface is pluggable, document in the spec/interface contract that any `LeaseStore` implementation must guarantee atomic, crash-safe writes — and write a test that specifically simulates a concurrent reader/writer on Windows CI (not just POSIX CI) for the JSON store. Given teardown is the highest-stakes write, consider writing teardown state changes with a stricter protocol (e.g., write-ahead marker file, or the same rename pattern but with mandatory retry and a hard failure surfaced as `cleanup_incomplete` rather than silently succeeding on a lost write).

**Warning signs:**
- CI only runs on Linux/macOS, not Windows, for the `LeaseStore` test suite.
- No retry/backoff around the rename step in the default JSON store.
- No test that runs two processes/handles against the same store file concurrently.

**Phase to address:** core state machine / LeaseStore (default JSON-file implementation), spec (LeaseStore atomicity contract).

---

### Pitfall 10: Expiry and time handling treated as wall-clock-safe when it isn't

**What goes wrong:**
Stint has already made the right call ("expiry enforced per call, not by timers") but per-call enforcement still requires correct time comparisons across at least three clocks that can disagree: the runtime's own clock, the publisher's clock (for PASETO `exp`/`iat` since v4.public is offline-verifiable), and the OAuth provider's clock (for token expiry). Bugs here manifest as either (a) false-negative — an expired license/lease still passes a call because of clock drift or a lenient/absent skew tolerance, quietly extending the revocation-latency window past the documented 5-minute TTL bound, or (b) false-positive — a valid lease rejected right at the boundary due to a few seconds of drift, which will look like a spurious `failed`/`expired` transition and erode trust in the whole system.

**Why it happens:**
"Check `Date.now() > exp`" looks trivially correct and usually is fine in a single-process demo, but distributed/offline verification (a defining feature of PASETO's offline-verifiable license design) means the signer and verifier are never guaranteed to share a clock.

**How to avoid:**
Make clock-skew tolerance an explicit, documented, tested constant (not the library default of zero) wherever `exp`/`nbf` is checked — for both PASETO verification and OAuth token expiry checks — and pick a value deliberately small relative to the 5-minute license TTL so it doesn't undermine the revocation-latency guarantee (e.g., single-digit seconds, not minutes). Since expiry is checked per call rather than by a timer, make sure the per-call check is the *only* source of truth — no cached "is this lease still valid" boolean computed once and reused across a batch of calls, since that reintroduces a timer-like staleness window. Test the boundary explicitly: a call arriving 1 second before expiry succeeds, 1 second after (beyond configured skew) fails, and clock skew within tolerance on either side behaves as documented.

**Warning signs:**
- No configured/tested clock-skew tolerance value anywhere `exp` is checked.
- Any code path that caches an "is valid" result and reuses it across more than one call/tick.
- No boundary test for expiry at exactly the TTL edge.

**Phase to address:** core license (PASETO expiry check), core state machine (per-call expiry enforcement), proxy (per-call check wiring).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Deriving tool access level from manifest fields instead of runtime bindings | Faster to ship, no binding registry to build | Reopens the exact confused-deputy/rug-pull hole the design is meant to close | Never |
| Treating revoke-endpoint 2xx as proof of revocation | Simpler teardown code, feels "done" | Silent false confidence in receipts; users told a credential is dead when it isn't | Never — even in MVP, record the honest tri-state result |
| Hand-rolled `JSON.stringify` for receipt hashing instead of one canonical serializer | Faster to write initially | Cross-version/cross-environment hash mismatches later look like tampering | Never past first commit of the receipts package |
| No Windows CI for LeaseStore | Faster CI setup | Intermittent EPERM failures discovered by the (Windows) developer in the worst place: during teardown testing | Only acceptable very briefly before first teardown-path work begins |
| Skipping the refresh-in-flight lock for v0.1 (single agent, low concurrency) | Less state-machine complexity early | One accidental double-refresh silently kills the whole delegated grant and looks like a provider bug | Acceptable only if the example agent never makes concurrent tool calls; must be fixed before any multi-call-per-tick usage |
| Using library default (zero) clock-skew tolerance | Nothing to configure | Spurious expiry failures right at the TTL boundary, especially relevant given the tight 5-minute default TTL | Never for the license verification path; borderline acceptable elsewhere with a documented reason |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| MCP client/server (`@modelcontextprotocol/sdk`) | Letting tool descriptions/schemas fetched live from the server drive authorization decisions | Only use MCP-supplied tool names to *look up* the runtime-owned binding; never derive scope from server-supplied metadata |
| `oauth4webapi` | Forwarding the raw access token to the agent-facing surface for convenience | Proxy performs the downstream call itself; agent/model never receives a bearer token |
| `paseto` (panva) | Recomputing the implicit assertion value in two different places (issuance vs. verification) with subtly different serialization | One shared function for implicit-assertion construction, imported by both issuance and verification code |
| `oauth2-mock-server` (testing) | Testing only the happy path (revoke → 200 → done) and never simulating an RFC-7009-non-compliant or silently-no-op provider | Add a mock provider mode that returns 200 without actually invalidating the token, and assert the runtime doesn't over-trust that response |
| `node:crypto` for hashing | Hashing pretty-printed or differently-key-ordered JSON per call site | Single canonicalization module used everywhere a receipt/manifest hash is computed |
| Ajv (manifest validation) | Validating manifest shape but not re-validating the bound content hash on every use (only at initial consent) | Re-check manifest hash matches what was bound at consent time whenever the manifest is read again (e.g., on resume/refresh) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Per-call synchronous hash-chain append with no batching | Every tool call blocks on a full disk write to append one receipt | Keep writes correct-but-simple for v0.1 (single JSON-file store, low call volume in the example agent); revisit only if a real workload needs higher call throughput | Not a v0.1 concern given the example agent's call volume, but note it so it isn't assumed to scale as-is |
| Global lock on the LeaseStore file for every read+write | Fine for a single lease/single agent; becomes a bottleneck if multiple leases are active concurrently under one runtime instance | Scope locks per-lease-id where possible even in the JSON-file default, so unrelated leases don't serialize on each other | Only matters once more than one lease is commonly active at once — not a v0.1 blocker |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Trusting publisher-supplied verifier code | A malicious publisher's `resource_query` verifier could always return "approved" | Already correctly scoped in the design: publisher verifier code is never trusted, only `resource_query` (runtime-executed predicate), `user_confirm`, `none` — enforce this boundary in code, not just docs |
| Allowing MCP elicitation to substitute for HostAdapter approval | An agent's MCP client could intercept/spoof an "approval" that never reached the actual human via the HostAdapter | Already correctly decided: approvals go out-of-band through HostAdapter only, never MCP elicitation — add a test that a raw MCP elicitation response can never satisfy an `approvals.require_for` check |
| Free-form scope strings creeping in via a "quick fix" for an edge case | Once one free-form scope exists, deny-by-default reasoning about the fixed `read\|write\|send\|pay` vocabulary breaks down | Treat the fixed vocabulary as a hard constraint enforced by the Ajv schema and TypeScript types, not just convention |
| Treating attested (publisher-signed) receipt entries as equivalent in trust to verified (runtime-signed) ones when merging for the plain-language timeline | Users could be misled into thinking a publisher's self-reported action was independently confirmed | Already correctly scoped ("verified vs attested," "merged ordering is display-only") — make sure the UI/CLI rendering never drops the verified/attested distinction, only merges *ordering* |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Approval prompts showing raw tool/arg internals instead of the plain-language consequence | Users approve things they don't understand, undermining the whole consent model | HostAdapter reference implementation (CLI) should render "this will send $X to Y" style summaries derived from the binding, not raw JSON args |
| Teardown reported as a single boolean success/fail | Users can't tell which credential specifically failed to clean up | Every partial failure recorded per-credential (already decided) — make sure the CLI surfaces this per-credential, not just an aggregate |
| Revocation described as instant when it's TTL-bounded | User believes access is cut immediately when in fact a cached PASETO license can still verify for up to 5 minutes | Documented trust limit (already planned) — surface this in the CLI's revoke output itself, not only in README/spec |

## "Looks Done But Isn't" Checklist

- [ ] **Teardown orchestrator:** Often missing the honest tri-state result per credential (`revoked` / `discarded_revocation_unsupported` / `failed`) — verify by forcing a mock provider that doesn't support RFC 7009 and checking the receipt says so explicitly, not just "revoked: true".
- [ ] **Hash-chained receipts:** Often missing a canonical-serialization golden test — verify by asserting a fixture receipt hashes to a hardcoded value, and that re-serializing the same logical object via a different construction path (e.g. object literal vs. `Map` vs. JSON round-trip) produces the identical hash.
- [ ] **PASETO license verification:** Often missing explicit clock-skew tolerance and implicit-assertion shared derivation — verify by testing expiry at the exact TTL boundary and by testing that issuance and verification use the literal same function for the implicit assertion.
- [ ] **LeaseStore (JSON default):** Often missing Windows-specific retry-on-EPERM and concurrent-access testing — verify by running the store's test suite on Windows CI with a concurrent reader/writer test, not just POSIX CI.
- [ ] **Approval-to-execution path:** Often missing argument-hash binding between what was approved and what executes — verify by writing a test that mutates args after approval and asserts execution is rejected, not silently allowed.
- [ ] **Refresh token handling:** Often missing a refresh-in-flight guard — verify by firing two concurrent tool calls against a soon-to-expire token and asserting only one refresh request is sent to the mock AS.
- [ ] **Receipt redaction:** Often missing a compile-time-enforced boundary between raw args and receipt-storable data — verify the receipt-writer function's TypeScript signature cannot accept a raw args object at all.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|-----------------|-----------------|
| Manifest-derived scope enforcement shipped by mistake | HIGH | Requires re-auditing every existing lease's granted scopes against the correct runtime binding, since some leases may have been granted broader access than intended; treat as a security incident, not a refactor |
| Non-canonical receipt hashes already in production chains | HIGH | Cannot be fixed retroactively without breaking chain verification for existing users; must ship a versioned canonicalization scheme from day one so this never needs recovery |
| Refresh-token family revoked by a race in production | LOW | Detect via 401/invalid_grant, surface as customer-side revocation (already-planned lazy detection path), prompt re-consent; annoying but not a security issue |
| Windows EPERM causing a lost teardown write | MEDIUM | If write-ahead/failure is surfaced as `cleanup_incomplete` rather than silently lost, recovery is a re-run of teardown against last-known state; if silently lost, requires manual reconciliation against provider-side state |
| Clock-skew-caused spurious expiry rejections in production | LOW | Add/adjust skew tolerance constant, redeploy; no data loss, just user-visible false rejections until fixed |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| Tool binding trust source | spec + proxy | Test: manifest claims `read`, binding registry says `write` — proxy denies based on binding, not manifest |
| Token passthrough / confused deputy | proxy | Test/type-check: no code path outside `@stint/proxy`'s trusted core can obtain a raw bearer token |
| TOCTOU approval-to-execution | proxy + core state machine | Test: args mutated post-approval, pre-execution → execution rejected |
| PASETO implicit assertion / footer misuse | core license + spec | Test: issuance and verification share one assertion-derivation function; footer contents audited as non-sensitive |
| Revocation silent no-op | core receipts + teardown orchestrator | Test: mock AS returns 200 without invalidating token → receipt records `discarded_revocation_unsupported`, not `revoked` |
| Refresh token rotation race | proxy | Test: two concurrent expiring-token calls → exactly one refresh request sent |
| Hash-chain canonicalization / unanchored head | core receipts + cli | Test: golden-hash fixture; checkpoint exportable outside the store file |
| Secrets in errors/receipts | core receipts + proxy | Test: known secret value never appears in any receipt or log line after a forced OAuth/PASETO failure |
| Windows JSON store atomicity | core state machine (LeaseStore) | Test: Windows CI run with concurrent reader/writer against the default JSON store |
| Time/expiry handling | core license + core state machine + proxy | Test: boundary test at exact TTL edge with and without configured skew tolerance |

## Sources

- [Model Context Protocol has prompt injection security problems](https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/)
- [MCP Security: Complete Guide — SentinelOne](https://www.sentinelone.com/cybersecurity-101/cybersecurity/mcp-security/)
- [11 Emerging AI Security Risks with MCP — Checkmarx Zero](https://checkmarx.com/zero-post/11-emerging-ai-security-risks-with-mcp-model-context-protocol/)
- [ETDI: Mitigating Tool Squatting and Rug Pull Attacks in MCP (arXiv)](https://arxiv.org/pdf/2506.01333)
- [Securing MCP: a defense-first architecture guide — Christian Schneider](https://christian-schneider.net/blog/securing-mcp-defense-first-architecture/)
- [MCP Security - OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)
- [New Prompt Injection Attack Vectors Through MCP Sampling — Unit42](https://unit42.paloaltonetworks.com/model-context-protocol-attack-vectors/)
- [MCP Horror Stories: The GitHub Prompt Injection Data Heist — Docker](https://www.docker.com/blog/mcp-horror-stories-github-prompt-injection/)
- [Prompt Injection in MCP: Tool Poisoning and Blast Radius — Aptible](https://www.aptible.com/mcp-security/mcp-prompt-injection)
- [Refresh Token Rotation Grace Period (Overlap Window) — better-auth #8512](https://github.com/better-auth/better-auth/issues/8512)
- [The OAuth refresh-token race that logs your users out — the two-layer fix — DEV](https://dev.to/wartzarbee/the-oauth-refresh-token-race-that-logs-your-users-out-and-the-two-layer-fix-3obf)
- [Refresh Token Security: Best Practices for OAuth Token Protection — Obsidian Security](https://www.obsidiansecurity.com/blog/refresh-token-security-best-practices)
- [paseto-spec Rationale V3/V4 — paseto-standard](https://github.com/paseto-standard/paseto-spec/blob/master/docs/Rationale-V3-V4.md)
- [Promoting Misuse-Resistance in PASETO Libraries — Paragon Initiative Enterprises](https://paragonie.com/blog/2021/09/promoting-misuse-resistance-in-paseto-libraries)
- [panva/paseto docs](https://github.com/panva/paseto/blob/main/docs/README.md)
- [Building a tamper-evident audit log in NestJS with hash chains — DEV](https://dev.to/elwin_ernst/building-a-tamper-evident-audit-log-in-nestjs-with-hash-chains-4l76)
- [Why Your Audit Log Needs a Hash Chain — DEV](https://dev.to/mmdverse/why-your-audit-log-needs-a-hash-chain-3loo)
- [I hash-chained my agent's audit log. Then I found 13 breaks in it — kriya blog](http://kriyanative.com/blog/13-chain-breaks/)
- [Tamper-Evident Audit Trail for AI Agents — nono](https://nono.sh/blog/secure-agent-audit)
- [write-file-atomic EPERM on Windows — npm/write-file-atomic #227](https://github.com/npm/write-file-atomic/issues/227)
- [EPERM when renaming files on Windows — nodejs/node #29481](https://github.com/nodejs/node/issues/29481)
- [RFC 7009: OAuth 2.0 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009.html)
- [Token Revocation — OAuth.net](https://oauth.net/2/token-revocation/)
- [TOCTOU: What It Is and Why It Still Threatens Today's Applications — SecureFlag](https://blog.secureflag.com/2026/09/10/toctou-race-condition/)
- [An approver sees the model's original tool arguments, not the ones that will execute — pydantic-ai #6968](https://github.com/pydantic/pydantic-ai/issues/6968)
- [Computer-Use and TOCTOU: What You Click Is Not What You Get! — Embrace The Red](https://embracethered.com/blog/posts/2026/toctou-agent-what-you-click-is-not-what-you-get/)
- [Approval Is Not a Boolean — DEV](https://dev.to/gangan/approval-is-not-a-boolean-what-must-still-be-true-when-an-agent-resumes-4ib2)
- [Best Logging Practices for Safeguarding Sensitive Data — Better Stack](https://betterstack.com/community/guides/logging/sensitive-data/)
- [Keeping Secrets Out of Logs: Strategies That Work — GitGuardian](https://blog.gitguardian.com/keeping-secrets-out-of-logs/)
- [Your Stack Trace Is Leaking: Stop AI Debug-Pipeline Leaks — debugg.ai](https://debugg.ai/resources/stack-trace-leaking-ai-debug-pipelines-secrets-mitigations)

---
*Pitfalls research for: agent authorization runtime / MCP gateway / OAuth-for-agents / PASETO licensing / tamper-evident audit log (project: Stint)*
*Researched: 2026-09-27*
