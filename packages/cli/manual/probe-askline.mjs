/**
 * Bisect probe for the consent-prompt bug. Reproduces askLine() faithfully and
 * compares it against a plain callback readline, both over process.stdin/stdout
 * with a real (non-aborting) AbortController. Run in a real console:
 *   node manual/probe-askline.mjs
 */
import { createInterface as createPromisesInterface } from "node:readline/promises";
import { createInterface as createCbInterface } from "node:readline";

const controller = new AbortController(); // never aborted during the probe
const signal = controller.signal;

// ---- Variant A: faithful copy of src/adapter/prompt.ts askLine() ----
async function askLine(input, output, prompt, sig) {
  if (sig.aborted) return undefined;
  const terminal = output.isTTY === true;
  const rl = createPromisesInterface({ input, output, terminal });
  const closed = new Promise((resolve) => {
    rl.once("close", () => resolve(undefined));
  });
  try {
    const answer = rl.question(prompt, { signal: sig });
    return await Promise.race([answer, closed]);
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

// ---- Variant B: plain callback readline (the working probe) ----
function askCallback(input, output, prompt) {
  return new Promise((resolve) => {
    const rl = createCbInterface({ input, output });
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

console.log("stdin.isTTY =", process.stdin.isTTY, " stdout.isTTY =", process.stdout.isTTY, " node", process.version);

console.log("\n[A] askLine() faithful copy — type A then Enter:");
const a = await askLine(process.stdin, process.stdout, "A> ", signal);
console.log("  -> returned:", JSON.stringify(a), a === undefined ? "  <-- BUG: returned immediately / no wait" : "");

console.log("\n[B] plain callback readline — type B then Enter:");
const b = await askCallback(process.stdin, process.stdout, "B> ");
console.log("  -> returned:", JSON.stringify(b));

process.exit(0);
