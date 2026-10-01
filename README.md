# Stint

Stint is an open spec, the **Agent Lease Protocol (ALP)**, plus a TypeScript SDK for the human-facing lifecycle of specialist AI agents: install one, let it run a scoped job, and uninstall it cleanly. It sits on top of MCP and OAuth 2.1 and covers the part they deliberately leave out.

- The normative spec lives in [`spec/ALP.md`](spec/ALP.md) (version `alp/0.1`).
- The SDK is a pnpm monorepo: `@stint/spec` (schemas and generated types), `@stint/core` (lease state machine, receipts, licenses), `@stint/proxy` (the enforcement proxy and teardown) and `@stint/cli` (the `stint-cli` command).
- License: Apache-2.0.

> **Status: experimental.** `alp/0.1`. The spec, the wire formats and the CLI may still change. Not for production use yet.

## A manifest at a glance

A lease is a signed manifest, the exact thing the user consents to before an agent does anything. Trimmed from the payment-reconciler example:

```jsonc
{
  "spec_version": "alp/0.1",
  "agent": { "id": "payment-reconciler", "name": "Payment Reconciler" },
  "publisher": { "id": "reconciler-labs.example", "name": "Reconciler Labs" },
  "job": {
    "description": "Match settled Paystack transactions to open orders and mark them paid.",
    "verifier": { "type": "resource_query" }
  },
  "scopes": [
    { "resource": "paystack.transactions", "access": ["read"] },
    { "resource": "sheets.orders", "access": ["read", "write"] }
  ],
  "lease": { "max_duration_seconds": 3600 },
  "limits": { "max_actions": 500, "actions_per_hour": 300 },
  "approvals": { "require_for": ["irreversible"], "timeout_seconds": 60 },
  "auth": { "mode": "hybrid" },
  "cleanup": { "hook": { "url": "https://reconciler-labs.example/alp/cleanup" } }
}
```

The access vocabulary is fixed: `read`, `write`, `send`, `pay`. Approvals are required only for what the manifest marks irreversible. The user grants exactly this, and the proxy never lets a tool call exceed it.

## The problem

MCP tells an agent how to call tools. OAuth 2.1 tells a client how to obtain and revoke a token. Neither defines consent, revocation or uninstall for an agent's job:

- **Consent.** Who decides that this agent may read these two systems, spend up to this much, and stop after this many actions, and how is that decision shown to the user before it takes effect?
- **Revocation.** When the user changes their mind, or one of their accounts revokes access, what ends the agent's authority everywhere at once?
- **Uninstall.** When the job is over, for any reason, which credentials get revoked, which data gets deleted, and how does the user know it actually happened?

Stint answers these with a **lease**: a signed manifest describes the job, the access it needs (a fixed vocabulary of `read`, `write`, `send` and `pay`), its limits and its cleanup promises. The user consents to exactly that, and the lease then runs as a small state machine that always ends in one of a few terminal states.

The mechanism that makes the lease real is a lease runtime that runs as an **MCP proxy** between the agent and every system it touches. The agent never holds a real credential. Every tool call is checked against the lease by code outside the model, and the answer is allow, deny or require approval. Anything unbound is denied. So a prompt-injected or simply misbehaving agent cannot use a tool call to act outside the lease the user granted, however it was talked into trying.

The second half of the promise is the ending. When a lease ends, whether it completed, expired, hit a limit or was revoked, the runtime runs a fixed teardown: revoke every OAuth grant, invalidate the publisher license, call the publisher's cleanup hook, delete the cached lease data, and write a final signed receipt. A step that fails does not hide the others: the lease ends as `cleanup_incomplete` with each step's result recorded, and teardown can be retried. Receipts outlive the lease, and they say only what was actually observed.

## Auth modes: delegated, hosted, hybrid

A manifest's `auth.mode` is one of three values, and `hybrid` is the default when the field is absent (spec section 8).

**`delegated`.** The agent acts on the customer's own systems. The runtime acquires one delegated OAuth grant per entry in the manifest's `auth.delegated` list, each tying a provider to the resources it grants. Access tokens carry RFC 8707 resource indicators and are attached by the proxy only on outbound calls, never handed to the agent. If any one of the customer's grants is revoked, whether the runtime notices it directly or lazily through an `invalid_grant` or a 401, the whole lease is revoked.

**`hosted`.** The agent is the publisher's own service, and entitlement comes from the publisher. The publisher issues a short-lived PASETO v4.public license that names the lease, the job and the limits, and is bound to that lease and spec version so it cannot be replayed against another. The runtime holds the license. The agent never sees it, and it is never forwarded to any customer resource.

**`hybrid`.** Both at once: a publisher license for entitlement, and delegated OAuth grants for the customer's resources. This is the default, and it is the mode the payment-reconciler example uses: the publisher licenses the agent, and the customer grants it access to a payments provider and an orders sheet.

## Trust limits of hosted mode

Hosted and hybrid leases put a publisher in the loop, so it matters exactly what Stint does and does not promise. The spec states four limits that no implementation can build its way out of (section 13), and this README repeats them plainly instead of rounding them up:

1. **Attested is not verified, and not complete.** Some claims are facts the runtime observed itself (a tool call it allowed or denied, a state change, a teardown step it ran). Others are claims the publisher makes and the runtime merely relays, for example that its cleanup hook ran. The spec keeps these in two separate receipt chains, and a timeline marks each entry as verified or attested. An attested claim proves the publisher said it, not that it is the whole truth.
2. **A lease cannot stop cross-resource data flow.** Once an agent has legitimately read one resource, nothing in the protocol stops it correlating that with another resource it may also legitimately read.
3. **Publisher-side deletion is attested, not verified.** If a publisher says it deleted the data it retained, the runtime cannot confirm that. It can only record the claim.
4. **The runtime must be run by the user or a neutral party.** If the party operating the runtime has an interest in weakening enforcement, every guarantee rests on that party's honesty instead of on the protocol. A runtime run by the publisher defeats the point.

Some further limits follow from how the pieces work:

- The proxy governs MCP tool calls. It does not sandbox the agent process, so Stint makes no claim about network traffic the agent process might send on its own.
- A license can be checked offline, so revoking it cannot take effect instantly. Revocation latency is bounded by the license lifetime.
- A provider without RFC 7009 support cannot be verified as revoked. That outcome is recorded as `discarded_revocation_unsupported`, not as a revocation.
- The publisher's signing-key custody is outside the runtime's control.

In v0.1 the example's receipts timeline reflects this honestly: it shows `[verified]` entries for what the runtime saw, plus a teardown marker `cleanup_hook: attested_ok` for the publisher's cleanup step. That marker means the publisher's hook answered ok, and nothing more. There is no separate attested chain in v0.1 yet, so nothing in the timeline should be read as independently proving the publisher deleted anything.

## How Stint relates to Auth0, Arcade, Composio

Those manage connections and credentials for agents. They help an agent obtain, store and use tokens for third-party services. Stint is not a connection manager and not a hosted service. It is an open spec (with a reference runtime) for the part they leave out: a **job-scoped lease** that a user consents to, that enforcement code outside the model checks on every call, and that **ends**: teardown runs, every credential is revoked where the provider supports it, and the result is honestly receipted. You can run a Stint lease over grants any of those tools acquired; Stint governs what the agent may do with them and, when the job is over, runs the cleanup and records exactly which steps succeeded.

## Quickstart

You need Node 22.18 or newer and pnpm (enable it with `corepack enable`). Everything runs on loopback: a mock authorization server, a mock publisher, a mock payments provider and a mock orders sheet. No account and no network access are needed.

From a fresh clone, install the dependencies:

```sh
pnpm install
```

Build the workspace:

```sh
pnpm build
```

Then run the whole example with one command:

```sh
pnpm example:payment-reconciler
```

This runs the complete lifecycle of the payment-reconciler agent. It acquires the two customer grants, signs a manifest as the publisher, creates and activates a lease, serves it as an MCP proxy in a separate `stint-cli run` process, and lets a small agent read transactions and orders. The agent then attempts an irreversible write, which needs approval. On a real terminal you are asked to consent and to approve the write. With no terminal, consent is granted automatically (a notice says so) and the write is denied when the approval window closes, which is the fail-safe outcome. The demo then revokes the lease while the agent is still connected.

The output ends with the merged receipts timeline and a one-line summary such as `Lease <id> finished: cleaned_up (publisher cleanup attested).` Read the timeline as the audit trail: each line is tagged `[verified]` for something the runtime itself observed, and the teardown lists every step with its outcome, including the `cleanup_hook: attested_ok` line that records the publisher's own claim. Secrets never appear in it: receipts hold hashes and redacted summaries, never tokens or the license.

### The lifecycle, one command at a time

The wrapped command drives the same CLI you can use yourself. Each step below is a real `stint-cli` subcommand, in the order a lease moves through them. `<manifest>` is a signed manifest envelope, and the publisher, profile and credentials files describe the publisher's endpoints, the runtime's connector bindings and the seeded grants.

```sh
stint-cli create <manifest> --publisher <file>
stint-cli run <id> --profile <file> --credentials <file>
stint-cli revoke <id> --yes
stint-cli cleanup <id>
stint-cli receipts <id>
stint-cli verify <id>
```

- `stint-cli create` verifies the signed manifest, shows you what it asks for, and on your consent activates a lease. Hosted and hybrid leases also take the `--publisher` file.
- `stint-cli run` serves the lease as an MCP proxy over stdio. Point an agent's MCP client at it. Every call is decided by the lease before anything reaches a provider.
- `stint-cli revoke` ends the lease at once and runs teardown. `--yes` skips the confirmation prompt.
- `stint-cli cleanup` runs or retries teardown for a lease that has ended. If a step failed, such as the publisher's cleanup hook, the lease is `cleanup_incomplete`. Retrying resumes where it left off, never repeats a step that already succeeded, and never returns the lease to active.
- `stint-cli receipts` prints the merged timeline, and `stint-cli verify` (or `stint-cli receipts --verify`) checks the receipt chains and the signed checkpoint, reporting the exact point of a break if one has been tampered with.

The happy path, where the agent's job finishes and the manifest's outcome check passes before teardown, the approved-write path, the partial-teardown retry and the mid-run revocation are all exercised end to end by the example's test suite (`pnpm test:e2e`).
