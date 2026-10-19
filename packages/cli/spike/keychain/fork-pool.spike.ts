// THROWAWAY spike (never merges). A9: the N-API addon loads and works inside a
// vitest `pool: "forks"` worker, alongside the shared contract suite on the
// in-memory double.
import { randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { createInMemorySecretStore, createSecretStoreContractTests } from "@stint/core/testing";

describe("A9: addon under pool=forks", () => {
  it("runs in a forked child process, not a worker thread", () => {
    expect(isMainThread).toBe(true);
    expect(typeof process.send).toBe("function");
    console.log(`A9 worker pid=${String(process.pid)} VITEST_POOL_ID=${String(process.env.VITEST_POOL_ID)}`);
  });

  it("loads @napi-rs/keyring and round-trips an AsyncEntry inside the worker", async () => {
    const keyring = await import("@napi-rs/keyring");
    expect(typeof keyring.AsyncEntry).toBe("function");
    const entry = new keyring.AsyncEntry(`stint-spike-a9-${randomUUID()}`, "a9", {
      linux: { store: "secret-service" },
    });
    await entry.setPassword("a9-value");
    expect(await entry.getPassword()).toBe("a9-value");
    expect(await entry.deletePassword()).toBe(true);
    console.log("A9 addon loaded and round-tripped inside the forked worker");
  });
});

createSecretStoreContractTests(() => createInMemorySecretStore());
