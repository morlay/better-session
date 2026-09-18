import { defineCordisPluginConfig } from "@local/devkit";

export default defineCordisPluginConfig({
  entries: { index: "./src/index.ts" },
  client: {
    name: "@morlay/dsh-client-ui-conversation",
    entry: "./src/client/index.ts",
    externals: [/^@morlay\/dsh-client-ui-/],
  },
});
