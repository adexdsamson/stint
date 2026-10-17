import { stripVTControlCharacters } from "node:util";

/**
 * CSI escape sequences in both the 7-bit (`ESC [`) and 8-bit (`U+009B`) forms:
 * parameter bytes, then intermediate bytes, then a final byte -- e.g. the SGR
 * colour sequence `\u001b[31m`. Removed explicitly, and before any control
 * character is dropped, because `stripVTControlCharacters` does not remove the
 * whole sequence on every supported Node version: Node 22.18 drops the ESC but
 * leaves the parameter bytes behind, which would turn `\u001b[31mg` into the
 * printable `[31mg`. Doing it first, while the introducer is intact, keeps the
 * result identical across Node 22-26.
 */
// eslint-disable-next-line no-control-regex -- the ESC (U+001B) and C1 CSI (U+009B) introducers are exactly what we match to strip.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]/g;

/** Line/paragraph breaks and whitespace controls that become a single space in single-line contexts. */
const LINE_BREAKS = /[\n\r\t\v\f\p{Zl}\p{Zp}]+/gu;

/** Every remaining C0 control, DEL and C1 control (includes ESC, BS, NUL, BEL and CSI U+009B). */
const CONTROLS = /\p{Cc}/gu;

/** Bidi marks, embeddings, overrides and isolates (Trojan Source style spoofing). */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu;

/**
 * Neutralizes text that came from a manifest or receipt before it is printed
 * to a terminal (terminal-injection defense, Pitfall 7, T-06-09). Full CSI
 * sequences are removed first (see `CSI`), then Node's own
 * `stripVTControlCharacters` takes the remaining VT sequences (OSC and the
 * like); everything that survives and could still move the cursor, overwrite a
 * line, or reorder displayed text is then removed or collapsed to a space.
 */
export function sanitizeForTerminal(input: string): string {
  return stripVTControlCharacters(input.replace(CSI, ""))
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(BIDI, "");
}
