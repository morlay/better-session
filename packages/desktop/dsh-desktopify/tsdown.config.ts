import { defineConfig } from "tsdown";

const BIN_NAME = "dsh-desktopify";
const CLI_ENTRY = "./src/cli/index.ts";
// 上游 desktop-host 是 private 包、不发布：构建时把它的产物一起打进 dist，
// 工具运行时用自带副本，package.json 不再依赖该私有包。
const VENDOR_HOST = "../../vendor/deepseek-harness/apps/desktop-host";

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
    copy: [
      { from: `${VENDOR_HOST}/lib/index.js`, to: "dist/desktop-host/lib" },
      {
        from: `${VENDOR_HOST}/config/desktop.cordis.patch.yml`,
        to: "dist/desktop-host/config",
      },
      { from: `${VENDOR_HOST}/package.json`, to: "dist/desktop-host" },
    ],
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
