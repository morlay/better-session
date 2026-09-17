import { defineCordisPluginConfig } from "devkit";
import { defineConfig } from "tsdown";
import { presetHooks } from "./tool/generate-presets.ts";

export default defineConfig(async () => ({
  ...(await defineCordisPluginConfig()),
  hooks: presetHooks(),
}));
