import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalPackage } from "@local/devkit";
import { defineConfig } from "tsdown";

const BIN_NAME = "dsh-desktopify";
const CLI_ENTRY = "./src/cli/index.ts";

const HOST_DIR = dirname(
  fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-desktop-host/package.json")),
);

// The host payload resolves every `@deepseek-ai/*` package from the deployment's own
// `node_modules` (upstream `apps/desktop-host/tsdown.config.ts` bundles its sources only),
// so the variant keeps that boundary: same entry path, same manifest, same specifiers.
const HOST_EXTERNAL = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/dsh-jobs",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh/profile-boot",
];

// 三个变体都按同一条规则处理 `@local/*`：本地私有包从不发布，一律内联进产物
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
    // Only the manifest is upstream's: it carries the payload's identity and the dependency
    // list the closure walk materializes. `lib/index.js` comes from `./src/desktop-host`.
    copy: [{ from: `${HOST_DIR}/package.json`, to: "dist/desktop-host" }],
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
    name: `${BIN_NAME}-host`,
    entry: { "desktop-host/lib/index": "./src/desktop-host/index.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: HOST_EXTERNAL, alwaysBundle: isLocalPackage },
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
