import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";
import { defineConfig } from "tsdown";
import { transform } from "lightningcss";

const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
];

const PLUGIN_ID = "@morlay/ui-conversation-message-actions";

const CSS_VIRTUAL_PREFIX = "\0dsh-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source);
  if (existsSync(emitted)) return emitted;
  const marker = `${sep}lib${sep}types${sep}`;
  const boundary = emitted.indexOf(marker);
  if (boundary < 0) return emitted;
  return resolvePath(emitted.slice(0, boundary), "src", emitted.slice(boundary + marker.length));
}

export default defineConfig([
  {
    entry: { index: "src/index.ts", invariant: "src/invariant.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: false,
    platform: "node",
    clean: true,
  },
  {
    name: "ui-conversation-message-actions/client",
    entry: { client: "src/client/index.ts" },
    format: "cjs",
    platform: "browser",
    dts: false,
    sourcemap: false,
    clean: true,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS, /^@deepseek-ai\//],
      alwaysBundle: (id: string) =>
        CLIENT_EXTERNALS.includes(id) || id.startsWith("@deepseek-ai/") ? false : true,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    },
    plugins: [
      {
        name: "dsh-css-modules-inline",
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith(".module.css")) return null;
          const abs = importer !== undefined ? sourceAssetPath(source, importer) : source;
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX;
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
          const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
          this.addWatchFile(fileId);
          const source = await readFile(fileId);
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: "[hash]_[local]" },
            minify: true,
          });
          const classMap: Record<string, string> = {};
          for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name;
          const tagId = `${PLUGIN_ID}/${basename(fileId)}`;
          return [
            `const css = ${JSON.stringify(code.toString())};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {`,
            `  const tag = document.createElement("style");`,
            `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
            "  tag.dataset.pluginCss = tagId;",
            "  tag.textContent = css;",
            "  document.head.appendChild(tag);",
            "}",
            `export default ${JSON.stringify(classMap)};`,
          ].join("\n");
        },
      },
    ],
    outputOptions: {
      entryFileNames: "client.js",
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
]);
