import { defineCordisPluginConfig } from "devkit";

// 额外导出 ./wire（请求序列化 / 响应翻译的 wire 编解码层）。
export default defineCordisPluginConfig({
  entries: {
    wire: "./src/wire.ts",
  },
});
