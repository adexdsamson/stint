import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["**/dist/**", "**/.tsc/**", "**/node_modules/**", "**/coverage/**", "packages/*/src/generated/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts", "packages/*/tsdown.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{js,mjs}"],
  },
  {
    // vitest.config.ts / tsdown.config.ts are only reachable via
    // projectService's allowDefaultProject, whose synthesized default
    // program does not enable strictNullChecks — type-aware rules that
    // depend on it error out on these files, so disable type-checking here.
    ...tseslint.configs.disableTypeChecked,
    files: ["vitest.config.ts", "packages/*/tsdown.config.ts"],
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
]);
