import { defineCordisPluginConfig } from "devkit";

export default defineCordisPluginConfig({
  entries: { index: "./src/index.ts" },
  client: {
    name: "@morlay/dsh-client-ui-input-trigger",
    entry: "./src/client/index.ts",

    externals: [/^@morlay\/dsh-client-ui-/],
  },
});
