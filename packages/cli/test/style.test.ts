import { describe, expect, it } from "vitest";

import { colorDecision, createStyle } from "../src/render/style.js";

const ESC = "\u001b";

describe("createStyle", () => {
  it("emits plain text with no ANSI escapes when the decision is false", () => {
    const s = createStyle(false);
    for (const fn of [s.header, s.verified, s.attested, s.pass, s.fail, s.dim]) {
      const out = fn("x");
      expect(out).toBe("x");
      expect(out).not.toContain(ESC);
    }
  });

  it("wraps in ANSI escapes when the decision is true", () => {
    const s = createStyle(true);
    expect(s.header("x")).toContain(ESC);
    expect(s.pass("x")).toContain(ESC);
    expect(s.fail("x")).toContain(ESC);
  });
});

describe("colorDecision", () => {
  const tty = { isTTY: true };

  it("is true only for a TTY with no --json and no NO_COLOR", () => {
    expect(colorDecision({ json: false, env: {}, output: tty })).toBe(true);
  });

  it("is false under --json even on a TTY", () => {
    expect(colorDecision({ json: true, env: {}, output: tty })).toBe(false);
  });

  it("is false when NO_COLOR is present (even if empty)", () => {
    expect(colorDecision({ json: false, env: { NO_COLOR: "" }, output: tty })).toBe(false);
  });

  it("is false for a non-TTY output, even when FORCE_COLOR/CI are set (Pitfall 6)", () => {
    expect(
      colorDecision({ json: false, env: { CI: "1", FORCE_COLOR: "1" }, output: { isTTY: false } }),
    ).toBe(false);
    expect(colorDecision({ json: false, env: {}, output: {} })).toBe(false);
  });
});
