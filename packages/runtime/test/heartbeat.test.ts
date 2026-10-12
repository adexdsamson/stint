import { createInMemoryLeaseArtifactStore } from "@stint/core/testing";
import { parseRunHeartbeat } from "@stint/core";
import type { LeaseArtifactStore } from "@stint/core";
import { describe, expect, it } from "vitest";

import {
  RUN_HEARTBEAT_INTERVAL_SECONDS,
  RUN_LIVE_WINDOW_SECONDS,
  isRunLive,
  writeRunHeartbeat,
} from "../src/index.js";

const NOW = 10_000;

describe("parseRunHeartbeat", () => {
  it("accepts a beat with and without endedAt", () => {
    expect(parseRunHeartbeat({ v: 1, beatAt: 100 })).toEqual({ v: 1, beatAt: 100 });
    expect(parseRunHeartbeat({ v: 1, beatAt: 100, endedAt: 120 })).toEqual({ v: 1, beatAt: 100, endedAt: 120 });
  });

  it("rejects a wrong version, a non-integer, a negative, a string, a bad endedAt and a non-object", () => {
    expect(parseRunHeartbeat({ v: 2, beatAt: 100 })).toBeUndefined();
    expect(parseRunHeartbeat({ v: 1, beatAt: "100" })).toBeUndefined();
    expect(parseRunHeartbeat({ v: 1, beatAt: -1 })).toBeUndefined();
    expect(parseRunHeartbeat({ v: 1, beatAt: 1.5 })).toBeUndefined();
    expect(parseRunHeartbeat({ v: 1, beatAt: 100, endedAt: -3 })).toBeUndefined();
    expect(parseRunHeartbeat({ v: 1, beatAt: 100, endedAt: "x" })).toBeUndefined();
    expect(parseRunHeartbeat({ v: 1 })).toBeUndefined();
    expect(parseRunHeartbeat(null)).toBeUndefined();
    expect(parseRunHeartbeat([])).toBeUndefined();
    expect(parseRunHeartbeat("beat")).toBeUndefined();
  });
});

describe("heartbeat constants", () => {
  it("beat every 10 s and count a run live for 45 s", () => {
    expect(RUN_HEARTBEAT_INTERVAL_SECONDS).toBe(10);
    expect(RUN_LIVE_WINDOW_SECONDS).toBe(45);
  });
});

describe("isRunLive", () => {
  it("is false when no heartbeat was ever written", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(false);
  });

  it("is true for a beat exactly 45 s old and false for 46 s", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    await writeRunHeartbeat(artifacts, "lease-1", { v: 1, beatAt: NOW - 45 });
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(true);
    await writeRunHeartbeat(artifacts, "lease-1", { v: 1, beatAt: NOW - 46 });
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(false);
  });

  it("is false once the run recorded an endedAt, however fresh the beat", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    await writeRunHeartbeat(artifacts, "lease-1", { v: 1, beatAt: NOW - 1, endedAt: NOW - 1 });
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(false);
  });

  it("is true for an unparseable artifact, because skipping a probe only delays detection", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    await artifacts.put("lease-1", "run_heartbeat", { v: 7, junk: true });
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(true);
    await artifacts.put("lease-1", "run_heartbeat", "not an object");
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(true);
  });

  it("is true for a beat in the future (clock skew)", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    await writeRunHeartbeat(artifacts, "lease-1", { v: 1, beatAt: NOW + 500 });
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(true);
  });

  it("treats a read error like an unparseable value", async () => {
    const failing: LeaseArtifactStore = {
      get: () => Promise.reject(new Error("disk on fire")),
      put: () => Promise.resolve(),
    };
    expect(await isRunLive(failing, "lease-1", NOW)).toBe(true);
  });

  it("keeps leases apart", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    await writeRunHeartbeat(artifacts, "lease-1", { v: 1, beatAt: NOW });
    expect(await isRunLive(artifacts, "lease-1", NOW)).toBe(true);
    expect(await isRunLive(artifacts, "lease-2", NOW)).toBe(false);
  });
});

describe("writeRunHeartbeat", () => {
  it("round-trips through the artifact store", async () => {
    const artifacts = createInMemoryLeaseArtifactStore();
    await writeRunHeartbeat(artifacts, "lease-1", { v: 1, beatAt: 42, endedAt: 50 });
    expect(await artifacts.get("lease-1", "run_heartbeat")).toEqual({ v: 1, beatAt: 42, endedAt: 50 });
  });
});
