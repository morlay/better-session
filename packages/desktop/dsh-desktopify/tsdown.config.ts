import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const BIN_NAME = "dsh-desktopify";
const CLI_ENTRY = "./src/cli/index.ts";

const HOST_DIR = dirname(
  fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-desktop-host/package.json")),
);

export default defineConfig([
  {
    name: BIN_NAME,
    entry: {
      index: "./src/index.ts",
      "cli/index": CLI_ENTRY,

      "dev-client-bundles": "./src/dev-client/index.ts",
    },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: false,
    clean: true,
    deps: { neverBundle: ["electron"] },
    copy: [
      { from: `${HOST_DIR}/lib/index.js`, to: "dist/desktop-host/lib" },
      { from: `${HOST_DIR}/package.json`, to: "dist/desktop-host" },
    ],
    exports: {
      packageJson: true,
      devExports: true,
      legacy: true,
      exclude: ["cli/index"],
      bin: { [BIN_NAME]: CLI_ENTRY },

      customExports: {
        "./desktop-host": "./dist/desktop-host/lib/index.js",
      },
    },
  },
  {
    entry: {
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
