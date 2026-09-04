import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";
import { transform } from "lightningcss";
import type { TsdownPlugin, UserConfig } from "tsdown";

export interface CordisClientOptions {
  /** 插件 id（`__ModuleLoader__.load` 的 id 与样式 tag 前缀） */
  name: string;
  /** client 入口；默认 `./src/client/index.ts` */
  entry?: string;
  /** 追加 external（默认 react 系列 + `@deepseek-ai/*`） */
  externals?: (string | RegExp)[];
  /** 关闭 CSS Modules 内联；默认开启 */
  css?: boolean;
}

/** dsh client bundle 共享配置：单文件 cjs，`__ModuleLoader__.load` 手递。 */
export function defineCordisClientConfig(options: CordisClientOptions): UserConfig {
  const externals: (string | RegExp)[] = [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    // @deepseek-ai/* 由主应用提供；内联会嵌进别的插件的 load（duplicate factory）
    /^@deepseek-ai\//,
    ...(options.externals ?? []),
  ];

  return {
    name: `${options.name}/client`,
    entry: { client: options.entry ?? "./src/client/index.ts" },
    format: "cjs",
    platform: "browser",
    dts: false,
    sourcemap: false,
    clean: true,
    deps: {
      neverBundle: externals,
      alwaysBundle: (id: string) => !isExternal(id, externals),
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    },
    plugins: options.css === false ? [] : [cssModulesInlinePlugin(options.name)],
    outputOptions: {
      entryFileNames: "client.js",
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(options.name)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  };
}

function isExternal(id: string, externals: (string | RegExp)[]): boolean {
  return externals.some((e) => (typeof e === "string" ? id === e : e.test(id)));
}

const CSS_VIRTUAL_PREFIX = "\0dsh-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";

/** CSS Modules 内联插件：`.module.css` → 哈希类名 + 样式注入。 */
export function cssModulesInlinePlugin(pluginId: string): TsdownPlugin {
  return {
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
      const tagId = `${pluginId}/${basename(fileId)}`;
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {`,
        `  const tag = document.createElement("style");`,
        `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
        "  tag.dataset.pluginCss = tagId;",
        "  tag.textContent = css;",
        "  document.head.appendChild(tag);",
        "}",
        `export default ${JSON.stringify(classMap)};`,
      ].join("\n");
    },
  };
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source);
  if (existsSync(emitted)) return emitted;
  const marker = `${sep}lib${sep}types${sep}`;
  const boundary = emitted.indexOf(marker);
  if (boundary < 0) return emitted;
  return resolvePath(emitted.slice(0, boundary), "src", emitted.slice(boundary + marker.length));
}
