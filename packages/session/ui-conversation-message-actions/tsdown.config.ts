import { defineCordisPluginConfig } from "devkit";

export default defineCordisPluginConfig({
  entries: {
    plan: "./src/plan.ts",
    testing: "./src/testing.ts",
  },
  client: {
    name: "@morlay/ui-conversation-message-actions",
    entry: "./src/client/index.ts",

    externals: [/^@morlay\/dsh-client-ui-/],
  },
});
