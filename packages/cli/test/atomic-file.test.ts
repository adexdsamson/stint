import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "../src/exit.js";
import {
  LeaseBusyError,
  StoreCorruptError,
  atomicWriteJson,
  createKeyedQueue,
  readJsonRetry,
  withFileLock,
  withTransientRetry,
} from "../src/store/atomic-file.js";

function errno(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(code);
  e.code = code;
  return e;
}

const noSleep = () => Promise.resolve();

describe("withTransientRetry", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("retries %s until the op succeeds", async (code) => {
    let calls = 0;
    const result = await withTransientRetry(
      () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(errno(code)) : Promise.resolve("ok");
      },
      50,
      noSleep,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows a non-transient error (ENOSPC) on the first attempt", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls += 1;
          return Promise.reject(errno("ENOSPC"));
        },
        50,
        noSleep,
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(calls).toBe(1);
  });

  it("rethrows an error without a code immediately", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error("boom"));
        },
        50,
        noSleep,
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("gives up after the bound and rethrows the transient error", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls += 1;
          return Promise.reject(errno("EPERM"));
        },
        5,
        noSleep,
      ),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(5);
  });
});

describe("createKeyedQueue", () => {
  it("runs same-key work strictly in order and survives a prior rejection", async () => {
    const run = createKeyedQueue();
    const order: number[] = [];
    const a = run("k", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      throw new Error("first fails");
    });
    const b = run("k", () => {
      order.push(2);
      return Promise.resolve("second");
    });
    await expect(a).rejects.toThrow("first fails");
    await expect(b).resolves.toBe("second");
    expect(order).toEqual([1, 2]);
  });
});

describe("file helpers", () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), "stint-atomic-"));
    dirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("atomicWriteJson then readJsonRetry round-trips; missing file reads undefined", async () => {
    const dir = tmp();
    const file = path.join(dir, "x.json");
    expect(await readJsonRetry(file)).toBeUndefined();
    await atomicWriteJson(file, { a: 1 });
    expect(await readJsonRetry(file)).toEqual({ a: 1 });
  });

  it("readJsonRetry throws StoreCorruptError on torn JSON without echoing content", async () => {
    const dir = tmp();
    const file = path.join(dir, "torn.json");
    await writeFile(file, '{"secret": "hunter2", ');
    const err = await readJsonRetry(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreCorruptError);
    expect((err as CliError).code).toBe(EXIT_CODES.storeCorrupt);
    expect((err as CliError).message).not.toContain("hunter2");
  });

  it("withFileLock rejects with LeaseBusyError (exit leaseBusy) when the lock is held past the budget", async () => {
    const dir = tmp();
    const file = path.join(dir, "lease.json");
    await mkdir(dir, { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holder = withFileLock(file, () => gate, { timeoutMs: 5_000 });
    // give the holder time to acquire
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const err = await withFileLock(file, () => Promise.resolve("never"), { timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LeaseBusyError);
    expect((err as CliError).code).toBe(EXIT_CODES.leaseBusy);
    expect(Date.now() - started).toBeLessThan(3_000);
    release();
    await holder;
    // once released the lock is acquirable again
    await expect(
      withFileLock(file, () => Promise.resolve("ok"), { timeoutMs: 2_000 }),
    ).resolves.toBe("ok");
  });
});
