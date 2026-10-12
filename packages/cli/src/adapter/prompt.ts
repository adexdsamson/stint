import { createInterface } from "node:readline/promises";
import { clearLine, cursorTo } from "node:readline";

export type PromptInput = NodeJS.ReadableStream & { readonly isTTY?: boolean };
export type PromptOutput = NodeJS.WritableStream & { readonly isTTY?: boolean };

export interface AskLineOptions {
  /**
   * Display-only countdown. `remaining()` returns whole seconds left. It is
   * only drawn on an interactive terminal and NEVER produces an answer: the
   * outcome of a timeout belongs to core (D-05), the adapter only stops its UI.
   */
  readonly countdown?: { readonly remaining: () => number };
  /** Overrides `output.isTTY === true` (tests drive a terminal-mode interface with fake streams). */
  readonly terminal?: boolean;
}

/** `askSecret` options: `terminal` only. A secret never draws a countdown (10-02). */
export interface AskSecretOptions {
  /** Overrides `output.isTTY === true` (tests drive a terminal-mode interface with fake streams). */
  readonly terminal?: boolean;
}

/**
 * Asks one line on `input`/`output`. Resolves the typed line, or `undefined`
 * when there is no answer: the signal aborted, the input reached EOF, or the
 * interface failed. `undefined` is never an approval; callers must turn it
 * into a rejection so core folds it to deny/decline/reject.
 */
export async function askLine(
  input: PromptInput,
  output: PromptOutput,
  prompt: string,
  signal: AbortSignal,
  options: AskLineOptions = {},
): Promise<string | undefined> {
  if (signal.aborted) return undefined;

  const terminal = options.terminal ?? output.isTTY === true;
  const rl = createInterface({ input, output, terminal });
  // EOF guard: rl.question() never settles when the input ends.
  const closed = new Promise<undefined>((resolve) => {
    rl.once("close", () => {
      resolve(undefined);
    });
  });

  let timer: NodeJS.Timeout | undefined;
  const stopCountdown = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  signal.addEventListener("abort", stopCountdown, { once: true });

  const countdown = options.countdown;
  const promptWith = (seconds: number): string =>
    `${prompt}(${String(Math.max(0, Math.floor(seconds)))}s) `;

  try {
    const shown = countdown !== undefined && terminal ? promptWith(countdown.remaining()) : prompt;
    const answer = rl.question(shown, { signal });
    if (countdown !== undefined && terminal) {
      timer = setInterval(() => {
        cursorTo(output, 0);
        clearLine(output, 0);
        rl.setPrompt(promptWith(countdown.remaining()));
        rl.prompt(true);
      }, 1000);
      timer.unref();
    }
    return await Promise.race([answer, closed]);
  } catch {
    return undefined;
  } finally {
    stopCountdown();
    signal.removeEventListener("abort", stopCountdown);
    rl.close();
  }
}

/**
 * Asks one line with echo muted (`askSecret`, 10-02 D-A). Same contract as
 * {@link askLine}: resolves the typed line, or `undefined` when there is no
 * answer (abort, EOF, interface failure). The typed value is a SECRET: the
 * prompt itself is written to `output` BEFORE the readline interface exists,
 * and the interface is built over a wrapper that swallows every chunk, so the
 * typed characters are never written to any stream. Callers MUST treat
 * `undefined` as no-entry, never approval, and MUST NOT log, echo, receipt or
 * otherwise interpolate the resolved value.
 */
export async function askSecret(
  input: PromptInput,
  output: PromptOutput,
  prompt: string,
  signal: AbortSignal,
  options: AskSecretOptions = {},
): Promise<string | undefined> {
  if (signal.aborted) return undefined;

  const terminal = options.terminal ?? output.isTTY === true;
  // All-or-nothing muting (no chunk classification): the prompt rides a plain
  // write before the interface exists, so the muted writer can swallow everything.
  output.write(prompt);
  const muted: PromptOutput = Object.create(output) as PromptOutput;
  // The muted writer exists to discard its arguments: echoing anything would leak the typed secret (T-10-06).
  muted.write = (
    chunk: string | Uint8Array, // eslint-disable-line @typescript-eslint/no-unused-vars -- swallow-only writer
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), // eslint-disable-line @typescript-eslint/no-unused-vars -- swallow-only writer
    callback?: (error?: Error | null) => void, // eslint-disable-line @typescript-eslint/no-unused-vars -- swallow-only writer
  ): boolean => true;
  const rl = createInterface({ input, output: muted, terminal });
  // EOF guard: rl.question() never settles when the input ends.
  const closed = new Promise<undefined>((resolve) => {
    rl.once("close", () => {
      resolve(undefined);
    });
  });

  try {
    return await Promise.race([rl.question("", { signal }), closed]);
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}
