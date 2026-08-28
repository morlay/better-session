import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/adapter.ts", "src/serialize.ts", "src/translate.ts"],
  format: ["esm"],
  outDir: "lib",
  dts: true,
  sourcemap: false,
  platform: "node",
});
