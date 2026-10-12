import { describe, expect, it } from "vitest";

import * as main from "../../src/index.js";
import * as testing from "../../src/testing.js";

const TESTING_NAMES = [
  "createInMemorySecretStore",
  "createSecretStoreContractTests",
  "createInMemoryKeyProvider",
  "createKeyProviderContractTests",
  "createInMemoryLeaseArtifactStore",
  "createLeaseArtifactStoreContractTests",
  "createRecordingTelemetry",
  "createTelemetryContractTests",
] as const;

describe("port exports", () => {
  it("the main entry exports the port helper values", () => {
    expect(typeof main.SecretKeyError).toBe("function");
    expect(typeof main.assertValidSecretKey).toBe("function");
    expect(typeof main.assertValidSecretPrefix).toBe("function");
    expect(typeof main.leaseSecretPrefix).toBe("function");
    expect(typeof main.credentialSecretKey).toBe("function");
    expect(typeof main.parseGrantsArtifact).toBe("function");
  });

  it("builds the documented key shapes", () => {
    expect(main.credentialSecretKey("lease-1", "sheets.orders")).toBe("lease/lease-1/cred/sheets.orders");
    expect(main.leaseSecretPrefix("lease-1")).toBe("lease/lease-1/");
  });

  it("rejects a lease id that would leave its namespace", () => {
    expect(() => main.leaseSecretPrefix("a/b")).toThrow(main.SecretKeyError);
    expect(() => main.credentialSecretKey("a/../b", "x")).toThrow(main.SecretKeyError);
  });

  it("the main entry does not export any testing double or suite factory", () => {
    const exported = main as Record<string, unknown>;
    for (const name of TESTING_NAMES) {
      expect(exported[name]).toBeUndefined();
    }
  });

  it("the testing entry exports all eight as functions", () => {
    const exported = testing as Record<string, unknown>;
    for (const name of TESTING_NAMES) {
      expect(typeof exported[name]).toBe("function");
    }
  });
});
