import { describe, expect, it } from "vitest";

import { sanitizeForTerminal } from "../src/adapter/sanitize.js";

describe("sanitizeForTerminal", () => {
  it("removes ESC/CSI sequences and keeps the surrounding text", () => {
    const out = sanitizeForTerminal("\u001b[2Jx");
    expect(out).toBe("x");
  });

  it("removes OSC sequences (window-title / hyperlink injection)", () => {
    const out = sanitizeForTerminal("a\u001b]0;pwned\u0007b");
    expect(out).toBe("ab");
  });

  it("neutralizes carriage return so a line cannot be overwritten", () => {
    const out = sanitizeForTerminal("safe\rEVIL");
    expect(out).not.toContain("\r");
    expect(out).toBe("safe EVIL");
  });

  it("neutralizes backspace, NUL, DEL and bell", () => {
    const out = sanitizeForTerminal("a\bb\u0000c\u007fd\u0007e");
    expect(out).toBe("abcde");
  });

  it("removes C1 control characters including CSI U+009B", () => {
    const out = sanitizeForTerminal("a\u009b2Jb\u0085c");
    expect(out).not.toMatch(/\p{Cc}/u);
    expect(out.startsWith("a")).toBe(true);
  });

  it("removes bidi override and isolate characters", () => {
    const out = sanitizeForTerminal("abc‮def⁦ghi⁩‏؜");
    expect(out).toBe("abcdefghi");
  });

  it("collapses newlines and tabs to a single space for single-line contexts", () => {
    const out = sanitizeForTerminal("line one\nline two\r\n\tline three end");
    expect(out).toBe("line one line two line three end");
  });

  it("leaves plain text (including non-ASCII letters) untouched", () => {
    const text = "Reconcile orders for Zoë, 2026 - invoice #42 (EUR)";
    expect(sanitizeForTerminal(text)).toBe(text);
  });

  it("returns no ESC and no CR for a combined hostile string, preserving readable text", () => {
    const out = sanitizeForTerminal("\u001b[2Jhi\r");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\r");
    expect(out).toContain("hi");
  });
});
