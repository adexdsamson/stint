# Contributing to Stint

Thanks for your interest in Stint, the Agent Lease Protocol (ALP) and its reference TypeScript SDK. Stint is early and experimental (`alp/0.1`), so issues, discussion and focused PRs are all welcome.

## Ground rules

- **The spec is normative.** `spec/ALP.md` defines the protocol; the manifest JSON Schema in `@stint/spec` is the source of truth for the manifest shape, and TypeScript types are **generated** from it, never hand-edited. A change to the manifest shape starts in the schema and the spec, not in generated code.
- **Enforcement lives outside the model.** Security guarantees (deny-by-default, per-call policy, teardown) must be decided by plain code, never delegated to an agent or an LLM.
- **No secrets in logs or receipts, ever.** Receipts carry hashes and redacted summaries, never tokens or licenses. Credentials are never handed to the agent, and the license is never forwarded to a customer resource.
- **No hand-rolled crypto.** Use the vetted libraries already in the stack (`paseto`, `jose`, `node:crypto`).
- **Fixed vocabularies.** Access is `read | write | send | pay`; approvals are `send | pay | irreversible`; verifiers are `resource_query | user_confirm | none`. Don't introduce free-form scopes.

## Development setup

You need **Node 22.18+** and **pnpm** (enable it with `corepack enable`).

```sh
pnpm install
pnpm build
```

The repo is a pnpm workspace:

| Package | What it is |
|---------|------------|
| `@stint/spec` | Manifest/envelope JSON Schemas, generated types, canonical serializer |
| `@stint/core` | Lease state machine, policy engine, receipts, licenses, host/store contracts |
| `@stint/proxy` | The MCP enforcement proxy, credential vault, teardown orchestrator |
| `@stint/cli` | The `stint-cli` command and reference terminal/JSON adapters |
| `examples/payment-reconciler` | The hybrid-mode end-to-end example |

## Checks

Run these before opening a PR. Everything is ESM-only and TypeScript strict.

```sh
pnpm build          # tsdown + tsc project refs
pnpm typecheck      # tsc -b
pnpm lint           # eslint (flat config, type-aware)
pnpm test           # unit tests across packages (vitest)
pnpm test:e2e       # the payment-reconciler end-to-end suite
```

Tests should cover every state transition, every teardown path (including partial failure), and scope denial. If you fix a bug, add a test that fails without the fix.

> On low-memory machines a whole-repo `vitest`/`eslint` run can be heavy; you can scope to a package with `pnpm --filter @stint/<pkg> exec vitest run <file>` while iterating. CI runs the full suite on Linux and Windows (Node 22.18 and 24).

## Pull requests

- Keep PRs focused; one logical change per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for messages (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- Update `spec/ALP.md` and the schema together when you change the protocol, and regenerate types (`pnpm codegen`), so `pnpm codegen:check` stays green.
- Update the README and the example when you change user-facing CLI behavior; the README drift test enforces that documented commands are real.
- By contributing you agree your contributions are licensed under the project's **Apache-2.0** license.

## Reporting security issues

Because Stint's whole point is a security boundary, please **do not** file public issues for vulnerabilities in the enforcement path (a way to exceed a lease, leak a credential, or forge a receipt). Open a private security advisory on the repository instead.
