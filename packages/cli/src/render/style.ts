import { createColors } from "picocolors";

/** The named colour helpers every CLI renderer uses. */
export interface Style {
  readonly header: (text: string) => string;
  readonly verified: (text: string) => string;
  readonly attested: (text: string) => string;
  readonly pass: (text: string) => string;
  readonly fail: (text: string) => string;
  readonly dim: (text: string) => string;
}

/** What `colorDecision` needs to know about the environment; injectable for tests. */
export interface ColorDecisionInput {
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly output: { readonly isTTY?: boolean };
}

/**
 * The single place the "should we colour?" question is answered. Colour is
 * on only for an interactive TTY with neither `--json` nor `NO_COLOR`.
 * picocolors' own detection is deliberately NOT consulted: it forces colour
 * on under win32 and CI even for piped output (Pitfall 6).
 */
export function colorDecision({ json, env, output }: ColorDecisionInput): boolean {
  return !json && !("NO_COLOR" in env) && output.isTTY === true;
}

/**
 * Builds the colour helpers from an explicit boolean decision via
 * `createColors(decision)` (never picocolors' default export). With `false`
 * every helper is the identity, so `--json`, `NO_COLOR` and non-TTY output
 * are plain text.
 */
export function createStyle(decision: boolean): Style {
  const c = createColors(decision);
  return {
    header: (text) => c.bold(c.cyan(text)),
    verified: (text) => c.green(text),
    attested: (text) => c.yellow(text),
    pass: (text) => c.green(text),
    fail: (text) => c.red(text),
    dim: (text) => c.dim(text),
  };
}
