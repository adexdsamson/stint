#!/usr/bin/env node
import { createRealDeps } from "./real-deps.js";
import { main } from "./program.js";

// Never process.exit(): setting exitCode lets stdout/stderr flush and lock cleanup run.
void main(process.argv.slice(2), createRealDeps()).then((code) => {
  process.exitCode = code;
});
