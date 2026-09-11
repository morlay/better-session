import { defineCordisPluginConfig } from "devkit";

// 单入口：host（node 面）+ client（浏览器 bundle）由 devkit 内部组装——
// client 作为补充产物（ModuleLoader 手递 / external 策略 / CSS 内联均在
// client 工厂收敛），包级只需声明 client 的 name 与入口。
export default defineCordisPluginConfig({
  // 额外导出：./plan（编辑计划纯函数）与 ./testing（测试支撑）。
  entries: {
    plan: "./src/plan.ts",
    testing: "./src/testing.ts",
  },
  client: {
    name: "@morlay/ui-conversation-message-actions",
    entry: "src/client/index.ts",
  },
});
