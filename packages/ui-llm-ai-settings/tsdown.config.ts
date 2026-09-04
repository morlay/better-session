import { defineCordisPluginConfig } from "devkit";

// 单入口 host（空 apply）+ client（src/client/index.ts 自动探测）。
export default defineCordisPluginConfig();
