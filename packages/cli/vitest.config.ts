import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows CI file IO (atomic rename + proper-lockfile) exceeds Vitest's 5s default.
    testTimeout: 60_000,
    // Scenario e2e suites run the whole flow in beforeAll; the 10s hook default is too tight there.
    hookTimeout: 60_000,
  },
});
