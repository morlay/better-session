import { defineConfig } from "tsdown";

// 与上游 `apps/desktop-host` 同边界：`@deepseek-ai/*` 由部署自己的 `node_modules` 提供
// （`dependencies` / `peerDependencies` 里的包 tsdown 默认留着 external），vendor 里的
// `update-tasks` 与 `workspace-dependencies` 模块在构建期内联进产物。
export default defineConfig({
  name: "@morlay/dsh-desktop-host",
  entry: { index: "./src/index.ts" },
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  target: "es2024",
  fixedExtension: false,
  dts: false,
  clean: true,
});
