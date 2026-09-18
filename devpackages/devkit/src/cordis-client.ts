import { rolldown } from "rolldown";
import type { Plugin } from "rolldown";
import { cssInlinePlugins } from "./css.ts";

/** `__ModuleLoader__.load` 手递的三段：banner / intro / footer（构建与现场打包共用）。 */
const factoryBanner = (name: string): string =>
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`;
const FACTORY_INTRO = "var module = { exports: {} }; var exports = module.exports;";
const FACTORY_FOOTER = "return module.exports; } });";

export interface CordisClientOptions {
  /** 插件 id（`__ModuleLoader__.load` 的 id 与样式 tag 前缀） */
  name: string;
  /** client 入口；默认 `./src/client/index.ts` */
  entry?: string;
  /** 追加 external（默认 react 系列 + `@deepseek-ai/*`） */
  externals?: (string | RegExp)[];
  /** 产出 client 半的类型声明（宿主 face 通过它引用 client 契约，不进源码）；默认开启 */
  dts?: boolean;
}

/**
 * 一份 client bundle 的解析与替换约定：externals / 解析条件 / define。
 * tsdown 构建与开发态按需转译（dev-client-bundles）共用，避免两处规则漂移。
 */
export interface ClientBundleSpec {
  externals: (string | RegExp)[];
  conditionNames: string[];
  define: Record<string, string>;
}

/** @param options - 追加 external 与模块 id（用于 dev 态现场打包）。 */
export function clientBundleSpec(
  options: {
    externals?: (string | RegExp)[];
    mode?: string;
  } = {},
): ClientBundleSpec {
  const mode = options.mode ?? process.env.NODE_ENV ?? "production";
  return {
    externals: [...BASELINE, ...(options.externals ?? [])],
    conditionNames: [
      mode === "development" ? "development" : "production",
      "browser",
      "import",
      "module",
      "default",
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode),
      "import.meta.env.MODE": JSON.stringify(mode),
      "import.meta.env": JSON.stringify({ MODE: mode }),
    },
  };
}

/** client 入口的 entry 名（同一个 tsdown config 里与 host 入口并存）。 */
export const CLIENT_ENTRY = "client";

/** 声明产物后缀：由 tsdown 的 dts 直出，插件不碰。 */
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];

/**
 * 同一个 tsdown config 里的 client 入口处理：host 与 client 同一次构建，
 * exports / 声明因此来自一套产物视图。插件把 client 的**代码**换成自包含单文件
 * （模块表的 `require` 只认包名/种子，相对 chunk 引用会让工厂执行失败；而
 * host/client 共享的模块在分块模型下无法各留一份，所以这里用一次独立打包产出
 * 工厂文本，替掉 tsdown 的分块产物），并只保留 client 的 CJS 与 host 的 ESM。
 * client 的**声明**仍由 tsdown 的 dts 直出（client 仍是 entry）。
 * @param options - 插件 id、client 入口与追加 external。
 */
export function clientEntryPlugin(options: {
  name: string;
  entry: string;
  externals?: (string | RegExp)[];
}): Plugin {
  return {
    name: "dsh-client-entry",
    async generateBundle(_outputOptions, bundle) {
      const clientChunks: string[] = [];
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== "chunk") continue;
        if (DECLARATION_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) continue;
        const isClient = item.name === CLIENT_ENTRY;
        const isClientFormat = fileName.endsWith(".cjs");
        if (isClient !== isClientFormat) {
          delete bundle[fileName];
          continue;
        }
        if (isClient) clientChunks.push(fileName);
      }
      const target = clientChunks[0];
      if (target === undefined) return;
      const chunk = bundle[target];
      if (chunk === undefined || chunk.type !== "chunk") return;
      const code = await bundleClientFactory({
        name: options.name,
        entry: options.entry,
        ...(options.externals === undefined ? {} : { externals: options.externals }),
      });
      chunk.code = code;
      // 自包含：断掉 tsdown 分块留下的相对引用（模块表解析不到它们）。
      chunk.imports = [];
      chunk.dynamicImports = [];
      chunk.moduleIds = [];
    },
  };
}

/** 开发态现场打包：与 {@link defineCordisClientConfig} 同一份规则，产出注册脚本文本。 */
export interface ClientFactoryOptions {
  /** 插件 id：必须与装配行解析到的包名一致（模块表的键）。 */
  name: string;
  /** client 入口（绝对路径，或相对 `cwd`）。 */
  entry: string;
  /** 追加 external，语义同 {@link CordisClientOptions.externals}。 */
  externals?: (string | RegExp)[];
  /** 解析条件与 define 的模式；默认取 `NODE_ENV`（缺省 production，与发布构建一致）。 */
  mode?: string;
  /** 打包工作目录（默认 `process.cwd()`）。 */
  cwd?: string;
}

/**
 * 现场把一份 client 半打成 `__ModuleLoader__.load` 注册脚本，供开发态直载：
 * 页面仍按模块系统的工厂契约（同步 CJS）执行，只是字节由源码现场产出。
 * @param options - 模块 id、入口、追加 external 与模式。
 * @returns 注册脚本文本（不含 source map）。
 * @throws {Error} 打包未产出 chunk 时。
 */
export async function bundleClientFactory(options: ClientFactoryOptions): Promise<string> {
  const spec = clientBundleSpec(
    options.externals === undefined ? {} : { externals: options.externals },
  );
  const build = await rolldown({
    input: options.entry,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // tsdown 对 `format: 'cjs'` 的产物按 node 平台解析；现场打包保持一致，
    // 否则内置模块与条件解析会和发布产物分叉。
    platform: "node",
    resolve: { conditionNames: spec.conditionNames },
    transform: { define: spec.define },
    external: (id: string) => isClientExternal(id, spec.externals),
    // 样式内联进字节：产物是自包含单文件，样式不能留在外部（见 cssInlinePlugins）。
    plugins: cssInlinePlugins({ name: options.name }),
  });
  try {
    const { output } = await build.generate({
      format: "cjs",
      codeSplitting: false,
      entryFileNames: "client.js",
      banner: factoryBanner(options.name),
      footer: FACTORY_FOOTER,
      intro: FACTORY_INTRO,
    });
    const chunk = output.find((item) => item.type === "chunk");
    if (chunk === undefined || chunk.type !== "chunk")
      throw new Error(`devkit: bundleClientFactory(${options.name}) produced no chunk`);
    return chunk.code;
  } finally {
    await build.close();
  }
}

function isExternal(id: string, externals: (string | RegExp)[]): boolean {
  return externals.some((e) => (typeof e === "string" ? id === e : e.test(id)));
}

/** 平台 baseline：主应用种子或静态表提供的模块（React / cordis / 共享原语）。 */
const BASELINE: (string | RegExp)[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  /^@deepseek-ai\/cordis(\/|$)/,
  /^@deepseek-ai\/dsh-client-store(\/|$)/,
  /^@deepseek-ai\/dsh-client-ui-slots(\/|$)/,
  /^@deepseek-ai\/dsh-client-ui-primitives(\/|$)/,
  /^@deepseek-ai\/dsh-client-ui-dockkit(\/|$)/,
];

/**
 * 「契约层」：可安全内联的纯函数 / 线格式模块——没有需要跨插件共享的运行时身份
 * （无单例、Symbol、instanceof 判定）。名单与上游 client 构建的 `INLINE_SAFE` 对齐：
 * 这些包不是 client 插件行（没有模块表条目），require 它们必然运行时抛错。
 */
const INLINE_SAFE =
  /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-agent-presets\/display$|@deepseek-ai\/dsh-spill-policy\/notice$|@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$))/;

/** 判断一个模块是否留给平台/模块表（其余一律内联）。 */
export function isClientExternal(id: string, externals: (string | RegExp)[]): boolean {
  if (isExternal(id, externals)) return true;
  if (!id.startsWith("@deepseek-ai/")) return false; // 第三方库内联
  // 契约层内联：这些包不是 client 插件行（模块表没有条目），require 必然运行时抛错。
  if (INLINE_SAFE.test(id)) return false;
  return true; // 其余 @deepseek-ai/* 是 client 插件行，由模块表提供
}
