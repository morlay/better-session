import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/invariant.ts"],
  format: ["esm"],
  outDir: "lib",
  dts: true,
  sourcemap: true,
  platform: "node",
  deps: {
    neverBundle: true,
  },
});
