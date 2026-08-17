import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";
import { defineConfig } from "tsdown";
import { transform } from "lightningcss";

/** 平台模块表：shell 预置在 __ModuleLoader__ 里的 specifier，bundle 必须 external。 */
const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-runtime/client",
];

const PLUGIN_ID = "@morlay/ui-conversation-message-actions";

/**
 * CSS Modules 虚拟 id 包装：把 `*.module.css` 解析为虚拟模块，返回 hashed
 * class 映射 + 一段在 factory 执行时注入 `<style data-plugin>` 的代码。
 * 虚拟 id 以 `.mjs` 结尾（不是 `.css`），避开 tsdown 自身的 css 守卫
 * （@tsdown/css）；否则 CSS 文本会被抽成独立的 style.css 而不被浏览器加载
 * （client-modules 只服务 client.js）。方案照搬官方 tsdown.client.ts。
 */
const CSS_VIRTUAL_PREFIX = "\0dsh-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";

/** Resolve an emitted JS asset import against its source-tree counterpart. */
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
    // Host 半：node ESM（lib/，主入口）。
    entry: { index: "src/index.ts", invariant: "src/invariant.ts" },
    format: ["esm"],
    outDir: "lib",
    dts: true,
    sourcemap: true,
    platform: "node",
    deps: {
      neverBundle: true,
    },
  },
  {
    // Browser 半：client bundle（lib/client.js），经 __ModuleLoader__.load 手递。
    // 必须产出**单文件**：client-modules 只服务/加载 `client.js`，任何 rolldown
    // 拆出的共享 chunk（shiki 语言包等）既不被加载（不在模块表）也不被服务
    // （/plugins/<id>/client.js 之外的路径 404），factory 里的相对 require 会
    // 直接 missed the module table。因此所有非平台模块全内联 + 动态 import
    // 合并（官方 tsdown.client.ts 的 noExternal 同款策略）。
    name: "ui-conversation-message-actions/client",
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS, /^@deepseek-ai\//],
    // 单文件策略：第三方依赖（shiki/katex 等）全内联；**@deepseek-ai/\* 一律
    // external** —— 平台模块走 seed 词（CLIENT_EXTERNALS），独立插件（如
    // ui-conversation，chat-node 经 `…/client` 子路径引用）由各自的 client
    // bundle 注册 factory（boot 的 inject 顺序保证先加载；client-modules 的
    // require 会 strip `/client` 后缀解析）。内联 @deepseek-ai 会把另一个
    // 插件的 `__ModuleLoader__.load` 嵌进来，导致 duplicate factory。
    noExternal: (id: string) =>
      CLIENT_EXTERNALS.includes(id) || id.startsWith("@deepseek-ai/") ? undefined : true,
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
