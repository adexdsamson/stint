import { stripVTControlCharacters } from "node:util";

/** Line/paragraph breaks and whitespace controls that become a single space in single-line contexts. */
const LINE_BREAKS = /[\n\r\t\v\f\p{Zl}\p{Zp}]+/gu;

/** Every remaining C0 control, DEL and C1 control (includes ESC, BS, NUL, BEL and CSI U+009B). */
const CONTROLS = /\p{Cc}/gu;

/** Bidi marks, embeddings, overrides and isolates (Trojan Source style spoofing). */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu;

/**
 * Neutralizes text that came from a manifest or receipt before it is printed
 * to a terminal (terminal-injection defense, Pitfall 7, T-06-09). The first
 * pass is Node's own `stripVTControlCharacters` (no hand-rolled VT regex);
 * everything that survives it and could still move the cursor, overwrite a
 * line, or reorder displayed text is then removed or collapsed to a space.
 */
export function sanitizeForTerminal(input: string): string {
  return stripVTControlCharacters(input)
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(BIDI, "");
}
