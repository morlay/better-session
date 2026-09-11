import { defineCordisPluginConfig } from "devkit";

// 额外导出：./artifact（日志/artifact 格式层）、./storage（存储引擎层）、
// ./import（导入 API）、./testing（跨包测试支撑）。
export default defineCordisPluginConfig({
  entries: {
    artifact: "./src/artifact.ts",
    import: "./src/import.ts",
    storage: "./src/storage.ts",
    testing: "./src/testing.ts",
  },
});
