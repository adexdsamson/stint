# Phase 3: Receipts & Licensing - Deferred Items

Issues discovered during execution that are out of scope for the plan that found them (Scope Boundary rule: only auto-fix issues directly caused by the current task's own changes).

## Found during 03-03 (attested chain + display-only merge)

### ✓ RESOLVED (regression gate, 2026-09-28) — `packages/spec/test/codegen.test.ts` "codegen check detects stale types" ENOENT

**Resolution:** Fixed during Phase 3's regression gate. The test's temp `--schema-dir` fixture now copies *all* `spec/*.schema.json` files dynamically (via `readdirSync().filter(.schema.json)`) instead of hardcoding two, so it stays correct as schema targets grow. `packages/spec` now 80/80 green. Retained below for history.



- **Symptom:** `pnpm exec vitest run --pool=threads` in `packages/spec` fails one test: `codegen > codegen check detects stale types` throws `ENOENT: no such file or directory, open '...\receipt.schema.json'` instead of the expected `stderr` containing `"stale"`.
- **Root cause (pre-existing, introduced in 03-01, not 03-03):** `packages/spec/scripts/codegen.mjs`'s `targets` array was extended in 03-01 (commit `b1c8f37`) to include `receipt.schema.json` and `checkpoint.schema.json` alongside `manifest.schema.json`/`envelope.schema.json`. `packages/spec/test/codegen.test.ts`'s "detects stale types" test (unmodified since Phase 1, commit `e8049ba`) builds a temp `--schema-dir` by `cpSync`-ing only `manifest.schema.json` and `envelope.schema.json` into it, then runs `codegen.mjs --check --schema-dir <tempDir>`. Since 03-01, `codegen.mjs` unconditionally tries to read all four schema files from `schemaDir`, so it now throws `ENOENT` on the missing `receipt.schema.json` before it ever reaches the "stale" detection logic the test asserts on.
- **Why deferred, not fixed here:** This regression predates 03-03 entirely — `codegen.test.ts` has not been touched since Phase 1, and the break was introduced by 03-01's `codegen.mjs` change, not by anything in this plan (03-03 only edited `spec/receipt.schema.json`'s `AttestedClaimPayload` definition and regenerated the already-stale-prone output; the ENOENT reproduces identically with or without that edit). 03-03's own `<verify>` scope is `packages/core/test/receipts/{attested-chain,merge}.test.ts`, which does not exercise this test. Per the Scope Boundary rule, out-of-scope pre-existing failures are logged here, not fixed inline.
- **Suggested fix (for whichever future plan picks this up):** either (a) have the test `cpSync` all four current schema files into `tempDir` instead of two, or (b) make `codegen.mjs` skip/report missing schema files as "stale" rather than throwing, so a partial `--schema-dir` degrades gracefully instead of crashing.
- **Verification that it's pre-existing:** `git log --oneline -- packages/spec/test/codegen.test.ts` shows only `e8049ba` (Phase 1); `git log --oneline -- packages/spec/scripts/codegen.mjs` shows `b1c8f37` (03-01) as the commit that added the two new targets this test's fixture doesn't account for.
