import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const BIN_NAME = "dsh-desktopify";
const CLI_ENTRY = "./src/cli/index.ts";
// 上游 desktop-host 是 private 包、不发布：构建时把它的产物一起打进 dist，
// 工具运行时用自带副本，发布形态不依赖该私有包。位置由 node 解析（包名 →
// devDependency 指向的 workspace 源码目录），不写死仓库目录布局。
const HOST_DIR = dirname(
  fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-desktop-host/package.json")),
);

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
      { from: `${HOST_DIR}/lib/index.js`, to: "dist/desktop-host/lib" },
      {
        from: `${HOST_DIR}/config/desktop.cordis.patch.yml`,
        to: "dist/desktop-host/config",
      },
      { from: `${HOST_DIR}/package.json`, to: "dist/desktop-host" },
    ],
    exports: {
      packageJson: true,
      devExports: true,
      legacy: true,
      exclude: ["cli/index"],
      bin: { [BIN_NAME]: CLI_ENTRY },
      // 上游 desktop-host 是 private 包，产物随工具发布：用子路径导出声明它的
      // 入口，运行期按包名解析定位（见 official-deps.ts），不写死 dist 内部路径。
      customExports: {
        "./desktop-host": "./dist/desktop-host/lib/index.js",
      },
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
