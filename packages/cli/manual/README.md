# Manual UAT helpers (Phase 6, Test 1)

Aids for the one human-verification item that automated tests can't cover: the
real-terminal consent and run-approval prompts on a live Windows console / POSIX tty.
Not part of the shipped package; not run by CI. Run from `packages/cli` after a build
(`npx --yes pnpm@12.6.0 --filter @stint/cli build`).

- `setup.mjs` — builds a temp store with a signed manifest, trust store, run profile,
  and credentials file; prints the exact `create` / run commands.
- `mcp-call.mjs` — drives a gated `send_notice` call over MCP stdio via the SDK's
  `StdioClientTransport` (how a real host spawns it). On Windows this uses
  `windowsHide: true`, so the approval prompt lands on a hidden console → the call
  times out and is denied (deny-by-default). This is the finding recorded in
  `.planning/phases/06-cli-reference-adapters/06-UAT.md`.
- `mcp-call-visible.mjs` — same, but spawns `stint run` with `windowsHide: false`
  (custom stdio transport) so the prompt shares the visible console — verifies the
  positive `y` approve path and `n` / timeout denials.
- `probe-tty.mjs` — checks whether `CONIN$`/`CONOUT$` open and are interactive here.
- `probe-adapter.mjs` — drives the real built consent adapter exactly as `create` does.
- `probe-askline.mjs` — isolates the `askLine` readline construction.
