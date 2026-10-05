Experimental. No stability promise yet. The API may change in any release before 1.0.

# @stint/runtime

The host-agnostic runtime for the Agent Lease Protocol. A host (a command line tool, an IDE extension, a server) hands this package a bundle of ports from `@stint/core`, and the package assembles the lease lifecycle on top of them: serving a lease as an MCP proxy, tearing a lease down, and settling a lease whose time ran out. The package imports no file-system, path, OS or child-process module, never reads the process global, and names no concrete storage backend.

## Entry points

There are three, and they are the whole supported surface.

- `createLeaseRuntime` (create a lease runtime): given the ports and a set of options (the lease id, an MCP transport, a host adapter, the verified manifest, the run profile and optionally credentials), serves the lease as an MCP proxy and returns a handle with `closed`, `close` and `verifyOutcome`. Credentials the secret store holds are loaded on demand, a refreshed token is written back to the store, and credentials passed in are copied in only when the store has none for that resource.
- `resolveTeardown` (resolve teardown): given the ports and a lease id, re-verifies the stored manifest and assembles everything teardown needs, with a fail-closed check that every recorded credential is available. It returns a handle that can run the teardown, retry a `cleanup_incomplete` lease and report which credentials are missing.
- `settleExpired` (settle expired): given the ports and a lease id, moves a `granted` or `active` lease whose expiry has passed to `expired` and records the transition. A second caller racing the first does nothing.

Each entry point is tagged `@experimental` in its JSDoc.

Failures are a `RuntimeError` with a `code` and a fixed, safe `safeMessage`. A host maps the code to its own surface, such as an exit code or an HTTP status.

## Ports

`RuntimePorts` has these members. The interfaces come from `@stint/core`; this package defines only the bundle.

- `leases`: the lease store.
- `receipts`: a function from a lease id to that lease's receipt store.
- `clock`: the current time in epoch seconds.
- `telemetry`: an optional observational sink. A sink that throws never changes an outcome.
- `secrets`: custody of the secret values a live lease holds.
- `artifacts`: per-lease non-secret artifacts such as the signed envelope, the publisher binding and the grants record.
- `keys`: the runtime's checkpoint signing key and the public keys a verifier may use.
- `trust`: resolves the publisher trust store each time it is needed.
- `fetch`: an optional HTTP transport for publisher calls. Absent means the global `fetch`.

An implementation of each storage port can be checked with the contract suites exported from `@stint/core/testing`, together with in-memory doubles for tests.

## File-backed implementations

This package ships no storage. The file-backed implementations of the ports, and the `buildRuntimePorts` function that assembles them under a store root, live in `@stint/cli`.
