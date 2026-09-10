import { defineConfig } from "tsdown";

const BIN_NAME = "dsh-desktopify";
const CLI_ENTRY = "./src/cli/index.ts";

export default defineConfig([
  {
    name: BIN_NAME,
    entry: { index: "./src/index.ts", "cli/index": CLI_ENTRY },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: false,
    clean: true,
    deps: { neverBundle: ["electron"] },
    exports: {
      packageJson: true,
      devExports: true,
      legacy: true,
      exclude: ["cli/index"],
      bin: { [BIN_NAME]: CLI_ENTRY },
    },
  },
  {
    // Sandboxed Electron preloads run as CommonJS even though the application package is ESM.
    entry: {
      preload: "./src/preload.ts",
      "preload-app": "./src/preload-app.ts",
    },
    outDir: "dist",
    format: ["cjs"],
    platform: "node",
    target: "es2024",
    dts: false,
    clean: false,
    deps: { neverBundle: ["electron"] },
  },
]);
