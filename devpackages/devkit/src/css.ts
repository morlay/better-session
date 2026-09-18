import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { transform } from "lightningcss";
import type { Plugin } from "rolldown";

// 虚拟 id 与上游 client 构建（vendor 的 tsdown.client.ts）同前缀同后缀：两条链的语义一致，
// 产物里注入的 style tag 也按同一约定（`data-plugin-css="<id>/<文件名>"`）可识别。
const MODULES_PREFIX = "\0dsh-css-modules:";
const GLOBAL_PREFIX = "\0dsh-global-css:";
const INLINE_PREFIX = "\0dsh-inline-css:";
// 后缀必须不是 `.css`：tsdown 自带的样式管线按 id 后缀识别样式模块，虚拟模块不能被它接管。
const VIRTUAL_SUFFIX = ".mjs";
const INLINE_QUERY = "?inline";

// 样式内联插件（CSS Modules / 全局 CSS / `?inline`）：`.module.css` 交 lightningcss 编译出 class
// 映射并在模块执行时注入样式，其余 `.css` 只注入，`.css?inline` 只导出编译后的文本。
// `options.name` 是插件 id（模块表键），写入注入 style tag 的 `data-plugin*` 属性；返回的插件
// 数组直接放进 `plugins`，两条链（tsdown 的 client 入口构建、bundleClientFactory 的现场打包）共用。
export function cssInlinePlugins(options: { name: string }): Plugin[] {
  const styleModule = (
    file: string,
    css: string,
    classMap?: Readonly<Record<string, string>>,
  ): string => {
    const tagId = `${options.name}/${basename(file)}`;
    const source = [
      `const css = ${JSON.stringify(css)};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      `if (typeof document !== "undefined" && document.querySelector(${JSON.stringify(
        `style[data-plugin-css="${tagId}"]`,
      )}) === null) {`,
      `  const tag = document.createElement("style");`,
      `  tag.dataset.plugin = ${JSON.stringify(options.name)};`,
      `  tag.dataset.pluginCss = tagId;`,
      `  tag.textContent = css;`,
      `  document.head.appendChild(tag);`,
      `}`,
    ];
    source.push(
      classMap === undefined ? "export {};" : `export default ${JSON.stringify(classMap)};`,
    );
    return source.join("\n");
  };

  return [
    {
      name: "dsh-css-modules-inline",
      resolveId: {
        // rolldown 在默认顺序的钩子之前剥离 import query、再把它拼回返回的 id；pre 才拿得到
        // 原始 specifier（vendor 侧同理，见 patches/css-inline-query.patch）。
        order: "pre",
        handler(source: string, importer: string | undefined) {
          if (!source.endsWith(".module.css")) return null;
          return MODULES_PREFIX + stylesheetPath(source, importer) + VIRTUAL_SUFFIX;
        },
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(MODULES_PREFIX)) return null;
        const file = unwrap(virtualId, MODULES_PREFIX);
        // 虚拟 id 让真实样式文件落在 rolldown 的 watch 图之外，这里补回来。
        this.addWatchFile(file);
        const { code, exports } = transform({
          filename: file,
          code: await readFile(file),
          cssModules: { pattern: "[hash]_[local]" },
          minify: true,
        });
        const classMap: Record<string, string> = {};
        for (const [local, entry] of Object.entries(exports ?? {})) classMap[local] = entry.name;
        return styleModule(file, code.toString(), classMap);
      },
    },
    {
      name: "dsh-css-text-inline",
      resolveId: {
        order: "pre",
        handler(source: string, importer: string | undefined) {
          if (!source.endsWith(`.css${INLINE_QUERY}`)) return null;
          const stylesheet = source.slice(0, -INLINE_QUERY.length);
          return INLINE_PREFIX + stylesheetPath(stylesheet, importer) + VIRTUAL_SUFFIX;
        },
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(INLINE_PREFIX)) return null;
        const file = unwrap(virtualId, INLINE_PREFIX);
        this.addWatchFile(file);
        const { code } = transform({
          filename: file,
          code: await readFile(file),
          minify: true,
        });
        return `export default ${JSON.stringify(code.toString())};`;
      },
    },
    {
      name: "dsh-css-global-inline",
      resolveId: {
        order: "pre",
        handler(source: string, importer: string | undefined) {
          if (!source.endsWith(".css")) return null;
          return GLOBAL_PREFIX + stylesheetPath(source, importer) + VIRTUAL_SUFFIX;
        },
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_PREFIX)) return null;
        const file = unwrap(virtualId, GLOBAL_PREFIX);
        this.addWatchFile(file);
        const { code } = transform({
          filename: file,
          code: await readFile(file),
          minify: true,
        });
        return styleModule(file, code.toString());
      },
    },
  ];
}

/** 样式文件的物理路径：相对 specifier 相对 importer 解析，绝对 specifier 原样使用。 */
function stylesheetPath(source: string, importer: string | undefined): string {
  return importer === undefined ? source : resolvePath(dirname(importer), source);
}

/** 还原虚拟 id 里的物理路径。 */
function unwrap(virtualId: string, prefix: string): string {
  return virtualId.slice(prefix.length, -VIRTUAL_SUFFIX.length);
}
