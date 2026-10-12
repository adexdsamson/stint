/**
 * File-backed supervisor control markers (Phase 9 SUP-06, D-19): the clock pause
 * a supervisor writes after a suspicious forward jump of the system clock and the
 * confirmation `stint-cli supervise --confirm-clock` writes to resume lease
 * expiry. They are two small JSON files under `<store>/supervisor/`, so a pause
 * survives a restart and a confirmation reaches a running supervisor with no
 * lock, no prompt and no signal (SIGUSR1 does not exist on Windows).
 *
 * A marker that is absent reads as `undefined`. A marker that exists but cannot
 * be parsed or does not match the strict shape throws `StoreCorruptError`; the
 * sweep treats that as a pause (fail closed, T-09-49) and never rewrites it.
 * Writes are atomic and tolerate the transient Windows errors, and a clear of a
 * file that is already gone is not an error.
 */

import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import { parseClockConfirm, parseClockPause } from "@stint/runtime";
import type { ClockConfirm, ClockPause, SupervisorControl } from "@stint/runtime";

import { supervisorDir } from "../paths.js";
import { StoreCorruptError, atomicWriteJson, readJsonRetry, withTransientRetry } from "./atomic-file.js";

const PAUSE_FILE = "clock-pause.json";
const CONFIRM_FILE = "clock-confirm.json";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The supervisor control markers of the store at `root`. */
export function createFileSupervisorControl(root: string): SupervisorControl {
  const dir = supervisorDir(root);
  const pauseFile = path.join(dir, PAUSE_FILE);
  const confirmFile = path.join(dir, CONFIRM_FILE);

  const read = async <T>(file: string, parse: (raw: unknown) => T | undefined): Promise<T | undefined> => {
    const raw = await readJsonRetry(file);
    if (raw === undefined) return undefined;
    const parsed = parse(raw);
    if (parsed === undefined) throw new StoreCorruptError();
    return parsed;
  };
  const write = async (file: string, value: ClockPause | ClockConfirm): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(file, value);
  };
  const clear = async (file: string): Promise<void> => {
    try {
      await withTransientRetry(() => unlink(file));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  return {
    readPause: () => read(pauseFile, parseClockPause),
    writePause: (pause) => write(pauseFile, pause),
    clearPause: () => clear(pauseFile),
    readConfirm: () => read(confirmFile, parseClockConfirm),
    writeConfirm: (confirm) => write(confirmFile, confirm),
    clearConfirm: () => clear(confirmFile),
  };
}
