import { defineCordisPluginConfig } from "@local/devkit";

export default defineCordisPluginConfig({
  entries: {
    artifact: "./src/artifact.ts",
    import: "./src/import.ts",
    deletion: "./src/deletion.ts",
    storage: "./src/storage.ts",
    testing: "./src/testing.ts",
  },
});
