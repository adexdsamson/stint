# Conformance Vectors

This directory holds the conformance vectors referenced by [spec/ALP.md](../ALP.md) Sections 4, 5 and 15. Every vector is plain, dependency-free JSON, or, for the JCS samples, plain text, so a non-TypeScript implementation can reproduce every value here without running any of Stint's own code.

## `valid/`

Each file is `{ description, manifest }`. `manifest` MUST validate against [spec/manifest.schema.json](../manifest.schema.json), including every conditional (`if`/`then`) rule and the two semantic rules ALP.md Section 4 states: delegated resources reference only scope resources, and scope resources are unique. `payment-reconciler.json` is, byte for byte, the annotated example in ALP.md Section 4; an automated check in `scripts/check-alp-sections.mjs` keeps the two from ever drifting apart.

## `invalid/`

Each file is `{ description, manifest, expected_errors }`. `manifest` MUST fail validation; `expected_errors` is a list of `{ path, code }` pairs a conforming validator MUST produce, one entry per distinct rejection reason the vector exercises (a manifest that fails for several independent reasons at once lists several entries). `code` is drawn from this project's own structured error vocabulary, for example `invalid_enum`, `missing_required`, `unknown_field`, `out_of_range`, `duplicate_item`, `unknown_resource_reference` or `unsupported_spec_version`. As ALP.md Section 15 states, matching this exact vocabulary is a Stint implementation detail, not a normative conformance requirement. What every implementation MUST match is the reject-or-accept outcome and the field each error's `path` names, using whatever error representation that implementation's own API prefers.

## `jcs/`

- `rfc8785-input.json` / `rfc8785-canonical.txt`: the exact JSON text from RFC 8785 Section 3.2.2 and its expected canonical output from Section 3.2.3, copied verbatim. Any RFC 8785-conformant canonicalizer MUST turn the first into the second, with no trailing newline in the output file.
- `manifest-input.json` / `manifest-canonical.json` / `manifest-expected-hash.txt`: the `payment-reconciler` manifest with its keys deliberately reordered and extra whitespace added, its canonical serialization, and the resulting content hash. The golden hash was computed independently of Stint's own code, by running `sha256sum` over the committed canonical bytes and prefixing the result with `jcs-sha256:`:

  ```
  jcs-sha256:$(sha256sum spec/vectors/jcs/manifest-canonical.json | cut -d' ' -f1)
  ```

  Reordering a manifest's keys or changing its whitespace MUST NOT change this hash; reordering an array, for example the two grants in `auth.delegated`, MUST change it, since RFC 8785 preserves array order.

## `receipts/`

- `chain-input.json`: a fixed, three-entry receipt chain (`transition`, then `call`, then `teardown_step`) on the `verified` chain, exercising the genesis link, an intermediate link and a `prevHash`-recompute walk. Each entry's `prevHash` is `jcs-sha256:` followed by the SHA-256 hex digest of the canonical serialization of the entry before it; the first entry's `prevHash` is the fixed genesis constant, `jcs-sha256:` followed by 64 zero hex characters.
- `chain-canonical.txt` / `chain-expected-hash.txt`: the canonical serialization and resulting content hash of `chain-input.json`'s last entry. As with the `jcs/` vectors, the hash was computed independently of Stint's own code, by running `sha256sum` over the committed canonical bytes and prefixing the result with `jcs-sha256:`:

  ```
  jcs-sha256:$(sha256sum spec/vectors/receipts/chain-canonical.txt | cut -d' ' -f1)
  ```

  A conforming implementation's `verifyChain` (or equivalent) MUST walk `chain-input.json` from the genesis constant and report the same head hash and entry count; altering any entry's `prevHash` MUST cause verification to report the exact broken sequence number, not a generic failure.
- `checkpoint-input.json`: a fixed checkpoint summary (`{ chain, count, headHash, ts }`, no `sig`) anchoring the `chain-input.json` golden chain — `count` equals the chain's length and `headHash` equals `chain-expected-hash.txt`'s value.
- `checkpoint-signing-input.txt`: the canonical (RFC 8785 JCS) serialization of `checkpoint-input.json`, the exact UTF-8 bytes an EdDSA signature is computed over.
- `checkpoint-key.jwk.json`: a fixed test Ed25519 keypair, committed for reproducibility only (see the warning below).
- `checkpoint-expected-sig.txt`: the base64url detached EdDSA signature over `checkpoint-signing-input.txt`'s bytes using `checkpoint-key.jwk.json`'s private key. Ed25519 (EdDSA) signing is deterministic (RFC 8032) — a conforming implementation's `signCheckpoint` (or equivalent) MUST reproduce this exact signature given the same key and input, and `verifyCheckpoint` MUST accept it against the matching public key while rejecting it against any other key or any mutated summary field.

## `envelope/`

- `test-key.jwk.json`: the published RFC 8037 Appendix A.1 Ed25519 test key (byte-identical to RFC 8032 Section 7.1 TEST 1, which RFC 8037's own appendix states it reuses verbatim), under `kid` `rfc8037-a1`.
- `trust-store.json`: a two-publisher trust store. `reconciler-labs.example` holds the A.1 key above; `other-publisher.example` holds a second, genuinely distinct key, RFC 8032 Section 7.1 TEST 2's public key, under `kid` `rfc8032-test2` (TEST 1 could not be reused a second time here, since it is the same key as A.1, and a second identical key would make every cross-publisher rejection vector accidentally verify instead of failing).
- `signed.json`, `tampered.json`, `unknown-kid.json`, `unknown-publisher.json`, `wrong-publisher.json`, `cross-signature.json`: six deterministic envelopes, all signing the same `payment-reconciler` manifest content, each exercising one outcome of the ALP.md Section 5 verification procedure.
- `expected.json`: the expected outcome for each of the six envelopes above, `{ valid, content_hash, publisher_id, kid }` for the one valid case and `{ valid: false, code, path }` for each rejection, using this project's own error vocabulary. ALP.md Section 15's rule applies here too: matching the accept/reject outcome and the signing input is normative, matching `code` exactly is a Stint implementation detail.
- The documented signing input (ALP.md Section 5) can be verified independently of any JOSE library: `ASCII("eyJhbGciOiJFZERTQSJ9") + "." + BASE64URL(JCS(manifest))`, checked with Ed25519 verification over that exact byte string using the public key named above.

**Warning:** every private key in this directory (`test-key.jwk.json`'s `d` member) is a published test vector from RFC 8032 and RFC 8037. It is public, reused across countless other test suites, and MUST NEVER be trusted, registered, or treated as a real signing key outside these conformance vectors.
