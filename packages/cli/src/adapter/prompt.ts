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
