# Changelog

## 0.2.0 (unreleased)

All `@stint/*` packages publish together as 0.2.0 when v0.2 ships. Nothing in this section has been published yet.

### Added

- `@stint/runtime`, a host-agnostic runtime with three entry points: `createLeaseRuntime`, `resolveTeardown` and `settleExpired`. It is marked experimental: the package description, its README and the JSDoc of each entry point say so, and there is no stability promise before 1.0.
- Four ports in `@stint/core` (secret store, key provider, lease artifact store and telemetry), with in-memory doubles and contract suites in `@stint/core/testing`.
- Credential kinds and per-credential clients: a credential can be an OAuth grant or an API key, and an OAuth grant carries its own client id and revocation endpoint, so a later revoke or cleanup needs no run profile.
- Durable credential custody. Credentials are copied into a secret store, a refreshed token is written back during a run, and cleanup revokes the current grant without a credentials file. Until the keychain store arrives the store is a plaintext file store, and every command that writes a credential says so on stderr.
- `stint-cli create --credentials <file>`, which seeds the store after consent, with the custody statement and a separate acknowledgement for a credential that cannot be revoked.
- `stint-cli run` serves a lease from the store alone once every expected credential is there, and tells you on stderr, when a credential first arrives, that one which cannot be revoked stays valid until you rotate it at the provider.
- The `teardown_blocked` receipt kind and the optional `resource` field on per-credential teardown receipts. Both are additive under `alp/0.1`.

### Changed

- A credential that cannot be revoked at the provider now ends the lease as `cleaned_up` with a caveat (`cleaned_up (credential not revoked upstream)` and one rotate line per resource) instead of `cleanup_incomplete`. The exit code is 0. ALP Section 10 records `discarded_revocation_unsupported` as terminal success with a caveat.
- An approval wait no longer holds the lease lock. `revoke`, teardown and other calls proceed while a person decides. A call approved after the lease expired or ended, or after a limit was reached, is now denied instead of executed, and the terminal says so.
- A teardown whose recorded credentials are missing from the store is blocked with exit 2 and a `teardown_blocked` receipt. The lease is left unchanged and the message names the command that supplies the credentials.
- Teardown and receipt appends are concurrency safe: a teardown pass runs inside the lease transaction, and a receipt append that would break the chain is rejected rather than forking it.
- `stint-cli create`, `run`, `revoke` and `cleanup` are thin hosts over `@stint/runtime`. `runLease` is still exported from `@stint/cli` with the same options.

### Breaking changes

- `SeededCredential` (`@stint/proxy`) is now a union of `OAuthSeededCredential` and `ApiKeySeededCredential`. It was an interface. Code that reads `accessToken` from a `SeededCredential` must narrow with `isApiKeyCredential` or use `OAuthSeededCredential`. `refreshAccessToken` now takes an `OAuthSeededCredential`.
- `createCredentialVault` takes an `OAuthClient` or an `OAuthClientResolver` first and a `CredentialVaultOptions` third (a superset of `RefreshOptions`, with a new `secrets` option). `revokeAndDiscardLeaseCredentials` takes an optional third parameter, `expectedResources`.
- `CredentialVault.discardLeaseCredentials` returns `void | Promise<void>` instead of `void`. It returns a promise only when the vault has a secret store.
- `LoadedCredential` (`@stint/cli`) is now a type alias of `OAuthSeededCredential`. It was an interface extending `SeededCredential`.
- `ReceiptStore.append` must reject with `ReceiptConflictError` when `entry.seq` differs from the number of entries stored for the chain. A third-party receipt store must add the check, and a caller that appends hand-built entries must supply the right `seq`. The `chain` parameter of `appendCallReceipt` is ignored.
- `createDefaultTeardownSteps` takes a sixth optional parameter, `options` (`expectedResources` and `secrets`). `TeardownDeps` gains an optional `credentialCheck`, and `runTeardown` and `retryTeardown` can reject with `TeardownBlockedError` when it is set. A failing durable discard or a leftover secret now makes step 4 `failed` and the lease `cleanup_incomplete`.
- `ReceiptEntry` has a new kind, `teardown_blocked`. Code that switches exhaustively over the receipt kinds must handle it.
- `ApprovalDecision` can now deny with the reasons `lease_ended` and `approval_queue_full`, in addition to `user_denied` and `timeout`. `LifecycleEvent` has a ninth member, `approval_void`. `ApprovalStage.requestApproval` takes an optional fourth parameter, and `ProxyDeps` gains optional `approvalWatchMs` and `telemetry`. A host that switches exhaustively on any of these must handle the new values.
- Inside `@stint/cli`, `reportTeardown` is now asynchronous and takes the store root, `buildTeardownDeps` and its mixed authorization server refusal are removed in favor of `resolveTeardown`, and the `LeaseBusyError` message now reads "The lease is busy: another operation holds it. Wait a moment, then retry." These are not exported from the package index.

### Known limits

- A second driver that joins a teardown already in flight cannot be told apart from crash recovery, so it may re-run a step the first driver just recorded as failed. No step succeeds twice and the chain never forks. Closing this needs driver ownership and fencing, planned for Phase 9.
- Credentials are stored unencrypted on disk until the keychain store arrives in Phase 12. On Windows the file is protected only by your user profile.
- API key grants are recorded only in the per-lease grants record, not in the manifest, so an edited or deleted grants record cannot be recovered for an API key.
- A step's side effects now run before its receipt inside one transaction. If the receipt append fails after the step ran, that pass does not record the outcome and the step runs again on the next pass.
- `stint-cli run` shows the notice for a credential that cannot be revoked on stderr and does not wait for an answer, because stdout is the MCP channel and a prompt would stop headless runs. The separate acknowledgement happens at `create --credentials`.
