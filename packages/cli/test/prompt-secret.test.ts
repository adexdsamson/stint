/**
 * Plan 10-02 Task 1: `askSecret`, the no-echo prompt beside `askLine`. The typed
 * value is a SECRET (an API key): the tests assert it resolves, and that neither
 * it nor any substring of it is ever written to the output stream.
 */

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { askSecret } from "../src/adapter/prompt.js";

const SECRET = "sk_test_abc123";

interface Rig {
  readonly input: PassThrough & { isTTY?: boolean };
  readonly output: PassThrough;
  readonly text: () => string;
  readonly chunks: () => string[];
}

/** Fake streams with the capture array `askLine`'s tests read (terminal mode by default). */
function rig(tty = true): Rig {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => {
    written.push(chunk.toString());
  });
  return { input, output, text: () => written.join(""), chunks: () => [...written] };
}

describe("askSecret", () => {
  it("resolves the typed line in terminal mode and never echoes it or any substring", async () => {
    const r = rig();
    const p = askSecret(r.input, r.output, "API key: ", new AbortController().signal, {
      terminal: true,
    });
    r.input.write(`${SECRET}\n`);
    await expect(p).resolves.toBe(SECRET);

    const text = r.text();
    expect(text).not.toContain(SECRET);
    for (const part of ["sk_test_abc123", "abc123", "sk_test", "****", "*"]) {
      expect(text, `output must not contain ${JSON.stringify(part)}`).not.toContain(part);
    }
  });

  it("resolves undefined on EOF without input and leaves no dangling interface", async () => {
    const r = rig();
    const p = askSecret(r.input, r.output, "API key: ", new AbortController().signal, {
      terminal: true,
    });
    r.input.end();
    await expect(p).resolves.toBeUndefined();
    expect(r.text()).toBe("API key: ");
  });

  it("resolves undefined when the signal aborts mid-wait", async () => {
    const r = rig();
    const controller = new AbortController();
    const p = askSecret(r.input, r.output, "API key: ", controller.signal, { terminal: true });
    controller.abort();
    await expect(p).resolves.toBeUndefined();
    expect(r.text()).toBe("API key: ");
    // The interface is disposed: the aborted prompt never consumes a later line.
    r.input.write("late-answer\n");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  });

  it("resolves undefined when the signal is already aborted", async () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    await expect(
      askSecret(r.input, r.output, "API key: ", controller.signal, { terminal: true }),
    ).resolves.toBeUndefined();
  });

  it("resolves the line identically in non-terminal (piped) mode, writing only the prompt", async () => {
    const r = rig(false);
    const p = askSecret(r.input, r.output, "API key: ", new AbortController().signal, {
      terminal: false,
    });
    r.input.write("piped-secret-value\n");
    await expect(p).resolves.toBe("piped-secret-value");
    expect(r.text()).toBe("API key: ");
    expect(r.text()).not.toContain("piped-secret-value");
  });

  it("writes the prompt text exactly once, before reading begins", async () => {
    const r = rig();
    const p = askSecret(r.input, r.output, "API key: ", new AbortController().signal, {
      terminal: true,
    });
    // The prompt is already on the stream before any answer exists.
    expect(r.chunks()).toEqual(["API key: "]);
    r.input.write(`${SECRET}\n`);
    await expect(p).resolves.toBe(SECRET);
    // Nothing was appended after reading: the one prompt chunk is the whole capture.
    expect(r.chunks()).toEqual(["API key: "]);
  });
});
