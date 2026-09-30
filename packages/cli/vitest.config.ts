import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows CI file IO (atomic rename + proper-lockfile) exceeds Vitest's 5s default.
    testTimeout: 60_000,
  },
});
