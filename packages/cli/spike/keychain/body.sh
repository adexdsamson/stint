#!/usr/bin/env bash
# THROWAWAY spike body (never merges). Runs from the repo root, after the dep is installed.
set -u
echo "::group::A1 evidence: prebuilt platform packages and .node binaries"
ls node_modules/.pnpm | grep -i "napi-rs+keyring" || true
find node_modules/.pnpm -name '*.node' -path '*keyring*' -print || true
echo "::endgroup::"
node packages/cli/spike/keychain/driver.mjs
rc=$?
echo "SPIKE-BODY-EXIT rc=$rc"
exit $rc
