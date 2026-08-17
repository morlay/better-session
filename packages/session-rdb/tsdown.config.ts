import { defineConfig } from "tsdown";

export default defineConfig({
  // 两个入口：主插件与 invariant companion（package.json exports 对应）。
  entry: ["src/index.ts", "src/invariant.ts"],
  // 纯 ESM 包（package.json type: module），node 平台，输出到 lib/（files 白名单）。
  format: ["esm"],
  outDir: "lib",
  dts: true,
  sourcemap: true,
  platform: "node",
  // 运行时依赖全部外部化：drizzle-orm / pg（dependencies）与
  // @deepseek-ai/*（peerDependencies）保持 import 原样，不打包。
  deps: {
    neverBundle: true,
  },
});
