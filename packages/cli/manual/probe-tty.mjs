/**
 * Probes whether the Windows controlling console (CONIN$/CONOUT$) can be opened
 * and driven interactively in THIS terminal — the assumption A1 unknown for
 * `stint run`. Run in a real console:  node manual/probe-tty.mjs
 */
import fs from "node:fs";
import tty from "node:tty";
import { createInterface } from "node:readline/promises";

const IN = "\\\\.\\CONIN$";
const OUT = "\\\\.\\CONOUT$";

let inFd, outFd;
try {
  inFd = fs.openSync(IN, "r+");
  console.log("opened CONIN$  fd", inFd, " isatty:", tty.isatty(inFd));
} catch (e) {
  console.log("CONIN$ open FAILED:", e.code || String(e));
}
try {
  outFd = fs.openSync(OUT, "r+");
  console.log("opened CONOUT$ fd", outFd, " isatty:", tty.isatty(outFd));
} catch (e) {
  console.log("CONOUT$ open FAILED:", e.code || String(e));
}

if (inFd !== undefined && outFd !== undefined && tty.isatty(inFd) && tty.isatty(outFd)) {
  const input = new tty.ReadStream(inFd);
  const output = new tty.WriteStream(outFd);
  output.write("\n>>> If you can read THIS line, CONOUT$ is visible here.\n");
  const rl = createInterface({ input, output, terminal: true });
  const a = await rl.question("Type z then Enter (reading from CONIN$): ");
  console.log("\nCONIN$ captured:", JSON.stringify(a), a === "z" ? " -> interactive console WORKS here" : "");
  rl.close();
  input.destroy();
  output.destroy();
} else {
  console.log("\n-> controlling console is NOT usable in this terminal (open failed or not a tty).");
  console.log("   stint run correctly denies-by-default here; verify the y/approve path in a standalone console window.");
}
process.exit(0);
