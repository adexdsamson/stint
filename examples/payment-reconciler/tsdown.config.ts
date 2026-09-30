import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/quickstart.ts"],
  format: "esm",
  platform: "node",
  dts: false,
  // platform: "node" defaults fixedExtension to true (.mjs output), which
  // doesn't match this package's "type": "module" layout. Force plain .js
  // output instead (tsdown 0.21.10).
  fixedExtension: false,
});
