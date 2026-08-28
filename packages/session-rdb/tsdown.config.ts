import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/invariant.ts"],
  format: ["esm"],
  outDir: "lib",
  dts: true,
  sourcemap: false,
  platform: "node",
});
