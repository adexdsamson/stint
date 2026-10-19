#!/usr/bin/env bash
# THROWAWAY spike body (never merges). Runs from the repo root, after the dep is installed.
set -u
rc=0

echo "::group::A1 evidence: prebuilt platform packages and .node binaries"
ls node_modules/.pnpm | grep -i "napi-rs+keyring" || true
find node_modules/.pnpm -name '*.node' -path '*keyring*' -print || true
echo "::endgroup::"

echo "::group::real-binding probe + contract-shaped exercise (run.mjs)"
pnpm --filter @stint/cli exec node spike/keychain/run.mjs || rc=1
echo "::endgroup::"

echo "::group::A9 vitest pool=forks (fork-pool + keychain contract)"
pnpm --filter @stint/cli exec vitest run --config spike/keychain/vitest.config.ts || rc=1
echo "::endgroup::"

echo "SPIKE-BODY-EXIT rc=$rc"
exit $rc
