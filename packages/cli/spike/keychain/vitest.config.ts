// THROWAWAY spike (never merges). A9: load the N-API addon inside a pooled fork worker.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["spike/keychain/**/*.spike.ts"],
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["verbose"],
  },
});
