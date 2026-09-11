import { defineCordisPluginConfig } from "devkit";
import { defineConfig, type UserConfig } from "tsdown";
import { presetHooks } from "./tool/generate-presets.ts";

// `defineCordisPluginConfig` 声明返回 `UserConfig | UserConfig[]`（本包无 client
// 源，实际恒为单个）。经 `defineConfig` 收敛为 UserConfig，避免推断类型引用
// 另一份 tsdown 副本的内部符号（TS2883）。
const host = defineConfig(defineCordisPluginConfig() as UserConfig);

// preset 产物由 `build:done` 生成到 outDir（见 presetHooks 注释）。
export default defineConfig({
  ...host,
  hooks: presetHooks(),
});
