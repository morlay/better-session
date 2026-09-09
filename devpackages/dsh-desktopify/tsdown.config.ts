import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/main.ts"],
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: { neverBundle: ["electron"] },
  },
  {
    // Sandboxed Electron preloads run as CommonJS even though the application package is ESM.
    entry: {
      preload: "src/preload.ts",
      "preload-app": "src/preload-app.ts",
    },
    outDir: "lib",
    format: ["cjs"],
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ["electron"] },
  },
]);
