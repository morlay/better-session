import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    invariant: "./src/invariant.ts",
  },
  exports: {
    packageJson: true,
    devExports: true,
    customExports: {
      "./cordis.patch.yml": "./cordis.patch.yml",
    },
  },
  format: ["esm"],
  deps: {
    onlyBundle: false,
  },
  clean: true,
});
