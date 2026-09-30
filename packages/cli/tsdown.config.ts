import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/bin.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  // platform: "node" defaults fixedExtension to true (.mjs/.d.mts output),
  // which doesn't match this package's "type": "module" + "./dist/index.js"
  // exports map. Force plain .js/.d.ts output instead (tsdown 0.21.10).
  fixedExtension: false,
});
