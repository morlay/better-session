import { isLocalPackage } from "@local/devkit";
import { defineConfig } from "tsdown";

const BIN_NAME = "dsh-desktopify";
const CLI_ENTRY = "./src/cli/index.ts";

// 两个变体都按同一条规则处理 `@local/*`：本地私有包从不发布，一律内联进产物
// （否则产物里留裸引用、发布清单里留依赖，消费方会去 registry 找一个不存在的包）。
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
    // 内联进来的 @local/devkit 客户端打包面要 rolldown / lightningcss：两者都是公开包，
    // 按既有边界留在产物外（并在清单里声明），否则它们自己的原生二进制解析不到。
    deps: {
      neverBundle: ["electron", "lightningcss", "rolldown"],
      alwaysBundle: isLocalPackage,
    },
    exports: {
      packageJson: true,
      devExports: true,
      legacy: true,
      exclude: ["cli/index"],
      bin: { [BIN_NAME]: CLI_ENTRY },
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
    deps: { neverBundle: ["electron"], alwaysBundle: isLocalPackage },
  },
]);
