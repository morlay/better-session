import { defineCordisPluginConfig } from "@local/devkit";

export default defineCordisPluginConfig({
  client: {
    name: "@morlay/ui-conversation-manager",
    entry: "./src/client/index.ts",
    // 样式来自我们自己的 css-in-js 原语行（模块表提供）；其余 @deepseek-ai/* 按
    // @local/devkit 的基线/契约层规则解析。
    externals: [/^@morlay\/dsh-client-ui-/],
  },
});
