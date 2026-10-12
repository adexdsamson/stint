/**
 * The supervisor's control markers (Phase 9 SUP-06, D-19): the clock pause the
 * supervisor writes after a suspicious forward jump of the wall clock, and the
 * confirmation an operator writes to resume lease expiry. Both are tiny
 * persisted records so they survive a restart and work without a prompt. The
 * runtime owns only the shapes, the strict parsers and the port; the host
 * stores the markers (the CLI keeps them as files under the store).
 *
 * A confirmation is bound to one pause by its random `id`: a confirmation
 * written before a pause existed, or for another pause, never matches (T-09-48).
 */

/** The pause marker: expiry settling is refused while it exists. */
export interface ClockPause {
  readonly v: 1;
  /** Random per pause; the confirmation must carry the same value. */
  readonly id: string;
  /** Epoch seconds at which the jump was detected. */
  readonly detectedAt: number;
  /** How far the wall clock moved beyond the monotonic clock, in whole seconds. */
  readonly jumpSeconds: number;
}

/** The operator's confirmation of one pause. */
export interface ClockConfirm {
  readonly v: 1;
  readonly id: string;
}

const MAX_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Version 1, a non-empty id of at most 128 characters and whole non-negative numbers; `undefined` on any mismatch. */
export function parseClockPause(raw: unknown): ClockPause | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const { id, detectedAt, jumpSeconds } = raw;
  if (!isValidId(id) || !isWholeNumber(detectedAt) || !isWholeNumber(jumpSeconds)) return undefined;
  return { v: 1, id, detectedAt, jumpSeconds };
}

/** Version 1 and a non-empty id of at most 128 characters; `undefined` on any mismatch. */
export function parseClockConfirm(raw: unknown): ClockConfirm | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const { id } = raw;
  if (!isValidId(id)) return undefined;
  return { v: 1, id };
}

/**
 * Where the markers live. A read resolves `undefined` when the marker is absent
 * and rejects when it exists but cannot be read or parsed, so the sweep can
 * fail closed. Clearing an absent marker is not an error.
 */
export interface SupervisorControl {
  readPause(): Promise<ClockPause | undefined>;
  writePause(pause: ClockPause): Promise<void>;
  clearPause(): Promise<void>;
  readConfirm(): Promise<ClockConfirm | undefined>;
  writeConfirm(confirm: ClockConfirm): Promise<void>;
  clearConfirm(): Promise<void>;
}

/** An in-memory control for tests and for hosts with no persistence. */
export function createInMemorySupervisorControl(): SupervisorControl {
  let pause: ClockPause | undefined;
  let confirm: ClockConfirm | undefined;
  return {
    readPause: () => Promise.resolve(pause),
    writePause: (next) => {
      pause = next;
      return Promise.resolve();
    },
    clearPause: () => {
      pause = undefined;
      return Promise.resolve();
    },
    readConfirm: () => Promise.resolve(confirm),
    writeConfirm: (next) => {
      confirm = next;
      return Promise.resolve();
    },
    clearConfirm: () => {
      confirm = undefined;
      return Promise.resolve();
    },
  };
}
