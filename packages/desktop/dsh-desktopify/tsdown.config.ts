import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
    deps: { neverBundle: HOST_EXTERNAL },
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
