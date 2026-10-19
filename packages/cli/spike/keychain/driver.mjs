// THROWAWAY spike (never merges). Runs every section as its own process with a hard
// timeout (a wedged native keychain call must not wedge the job), then the vitest A9 run.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, "run.mjs");
// gate=true: failing it fails the job. gate=false: characterization, reported but not gating.
const SECTIONS = [
  { name: "a1", label: "A1 prebuilt resolves + addon loads", gate: true },
  { name: "probe", label: "PROBE set/get/delete round trip", gate: true },
  { name: "sizes", label: "INFO single-entry size limits", gate: false },
  { name: "chunked10k", label: "CONTRACT 10k value, <=2048B chunks, sha256 identical", gate: true },
  { name: "concReadsUnserialized", label: "INFO 20 concurrent reads, one entry", gate: false },
  { name: "concRawUnserialized", label: "CHARACTERIZE 20 concurrent setPassword, one entry, unserialized", gate: false },
  { name: "concChunkedUnserialized", label: "CHARACTERIZE 20 concurrent chunked puts, unserialized", gate: false },
  { name: "concChunkedSerialized", label: "CONTRACT 20 concurrent chunked puts, in-process serialized", gate: true },
  { name: "prefixDelete", label: "CONTRACT prefix delete only its own segment", gate: true },
  { name: "enumerate", label: "INFO findCredentialsAsync enumerates by service", gate: false },
];

const rows = [];
let gateFailed = false;
for (const s of SECTIONS) {
  console.log(`::group::${s.name}`);
  const r = spawnSync(process.execPath, [run, s.name], { encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL" });
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  process.stdout.write(r.stdout ?? "");
  process.stdout.write(r.stderr ?? "");
  const status = timedOut ? "TIMEOUT(90s)" : r.status === 0 ? "PASS" : "FAIL";
  const last = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith(`[${s.name}] `)).pop() ?? "";
  console.log(`::endgroup::\n>>> ${s.name}: ${status}${s.gate ? "" : " (non-gating)"}`);
  if (status !== "PASS" && s.gate) gateFailed = true;
  rows.push({ ...s, status, detail: last.replace(/\|/g, "\\|").slice(0, 400) });
}

console.log("::group::A9 vitest pool=forks (fork-pool + keychain contract)");
const v = spawnSync("pnpm --filter @stint/cli exec vitest run --config spike/keychain/vitest.config.ts", {
  shell: true,
  stdio: "inherit",
  timeout: 420_000,
  killSignal: "SIGKILL",
});
const vStatus = v.error?.code === "ETIMEDOUT" || v.signal === "SIGKILL" ? "TIMEOUT(420s)" : v.status === 0 ? "PASS" : "FAIL";
console.log(`::endgroup::\n>>> vitest forks: ${vStatus}`);
rows.push({ name: "vitest", label: "A9 vitest pool=forks (addon in worker + contract suites)", gate: true, status: vStatus, detail: "" });
if (vStatus !== "PASS") gateFailed = true;

const md = [
  `### keychain spike: ${process.platform}/${process.arch}`,
  "",
  "| status | section | gating | detail |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.status} | ${r.label} | ${r.gate ? "yes" : "no"} | ${r.detail} |`),
].join("\n");
console.log("\n" + md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
process.exit(gateFailed ? 1 : 0);
