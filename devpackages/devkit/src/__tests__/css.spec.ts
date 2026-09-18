// @vitest-environment jsdom
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { rolldown } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleClientFactory } from "../cordis-client.ts";
import { defineCordisPluginConfig } from "../cordis-host.ts";
import { cssInlinePlugins } from "../css.ts";

// 插件 id：与现场打包的 `name` 同义，写入注入 style tag 的 `data-plugin*` 属性。
const PLUGIN_ID = "@morlay/devkit-css-fixture";

const FIXTURE_ENTRY = `import classes from "./styles/Fixture.module.css";
import inlined from "./styles/inline-only.css?inline";
import "./styles/global.css";
export { classes, inlined };
`;

const MODULE_CSS = `.root { color: red; }
.title { font-weight: bold; }
`;

const GLOBAL_CSS = `body { margin: 0; }
`;

const INLINE_CSS = `:root { --gap: 4px; }
`;

interface Registered {
  id: string;
  factory: (require: (id: string) => unknown) => Record<string, unknown>;
}

// 在 jsdom 里执行注册脚本，取出 `__ModuleLoader__.load` 手递的工厂并调用：注入的 `<style>`
// 与 class 映射只在工厂执行时出现，纯文本断言看不到。
function runFactory(code: string): Record<string, unknown> {
  const registered: Registered[] = [];
  Reflect.set(window, "__ModuleLoader__", {
    load(options: Registered): void {
      registered.push(options);
    },
  });
  // 产物的字节只在执行时才产生样式注入与 class 映射，文本断言看不到。
  runInThisContext(code);
  const host = registered[0];
  if (registered.length !== 1 || host === undefined)
    throw new Error(`expected exactly 1 factory, got ${registered.length}`);
  return host.factory(() => {
    throw new Error("fixture imports nothing external");
  });
}

// 产物里残留的样式 import：内联成功则一个都不该有。
function styleImports(code: string): string[] {
  return [...code.matchAll(/require\((["'])([^"']*\.css[^"']*)\1\)/g)].map(
    (match) => match[2] ?? "",
  );
}

// 注入的 style tag 文本，未注入时为 undefined。
function injectedCss(fileName: string): string | undefined {
  return (
    document.querySelector(`style[data-plugin-css="${PLUGIN_ID}/${fileName}"]`)?.textContent ??
    undefined
  );
}

describe("client bundle CSS", () => {
  let directory: string;

  beforeAll(async () => {
    // 取 realpath：rolldown 报出的 id / watch 路径都是真实路径（macOS 的 /var → /private/var）。
    directory = await realpath(await mkdtemp(join(tmpdir(), "devkit-css-")));
    await mkdir(join(directory, "styles"));
    await writeFile(join(directory, "styles", "Fixture.module.css"), MODULE_CSS);
    await writeFile(join(directory, "styles", "global.css"), GLOBAL_CSS);
    await writeFile(join(directory, "styles", "inline-only.css"), INLINE_CSS);
    await writeFile(join(directory, "entry.ts"), FIXTURE_ENTRY);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe("bundleClientFactory", () => {
    let code: string;

    beforeAll(async () => {
      code = await bundleClientFactory({ name: PLUGIN_ID, entry: join(directory, "entry.ts") });
    });

    it("inlines CSS Modules as a hashed class map plus an injected style tag", () => {
      const classes = runFactory(code)["classes"] as Record<string, string>;
      // `[hash]_[local]`：同一个样式表的每个 local 共享同一段 hash，local 名作为后缀。
      expect(classes["root"]).toMatch(/^[A-Za-z0-9_-]+_root$/);
      expect(classes["title"]).toBe(classes["root"]?.replace(/_root$/, "_title"));
      const injected = injectedCss("Fixture.module.css");
      expect(injected).toContain(`.${classes["root"]}{color:red}`);
      expect(injected).toContain(`.${classes["title"]}{font-weight:700}`);
    });

    it("injects a CSS Modules stylesheet only once across factory runs", () => {
      runFactory(code);
      runFactory(code);
      expect(
        document.querySelectorAll('style[data-plugin-css$="/Fixture.module.css"]'),
      ).toHaveLength(1);
    });

    it("inlines a global stylesheet into a style tag with no class map", () => {
      runFactory(code);
      expect(injectedCss("global.css")).toBe("body{margin:0}");
    });

    it("exports the compiled text of a `?inline` stylesheet and injects nothing", () => {
      const exports = runFactory(code);
      expect(exports["inlined"]).toBe(":root{--gap:4px}");
      expect(injectedCss("inline-only.css")).toBeUndefined();
    });

    it("leaves no stylesheet import in the artifact", () => {
      expect(styleImports(code)).toEqual([]);
      expect(code).not.toContain("inline-only.css?inline");
    });
  });

  describe("watch graph", () => {
    it("registers every stylesheet the plugin loads", async () => {
      const build = await rolldown({
        input: join(directory, "entry.ts"),
        platform: "node",
        plugins: cssInlinePlugins({ name: PLUGIN_ID }),
      });
      try {
        await build.generate({ format: "cjs", codeSplitting: false });
        expect(await build.watchFiles).toEqual(
          expect.arrayContaining([
            join(directory, "styles", "Fixture.module.css"),
            join(directory, "styles", "global.css"),
            join(directory, "styles", "inline-only.css"),
          ]),
        );
      } finally {
        await build.close();
      }
    });
  });

  // tsdown 那一次解析也必须认得样式 import：clientEntryPlugin 之后还要用现场打包的字节把
  // chunk 换掉，换之前 tsdown 自己的这次构建不能先断。
  describe("defineCordisPluginConfig", () => {
    it("hands the client entry pipeline a working CSS inliner", async () => {
      const cwd = process.cwd();
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: PLUGIN_ID, private: true, type: "module" }),
      );
      await mkdir(join(directory, "src", "client"), { recursive: true });
      await writeFile(
        join(directory, "src", "client", "index.ts"),
        'import classes from "../../styles/Fixture.module.css";\nexport { classes };\n',
      );
      process.chdir(directory);
      try {
        const config = await defineCordisPluginConfig({
          client: { name: PLUGIN_ID, entry: "./src/client/index.ts" },
        });
        const inputOptions = typeof config.inputOptions === "function" ? {} : config.inputOptions;
        const build = await rolldown({
          input: "./src/client/index.ts",
          platform: "node",
          ...(inputOptions?.resolve === undefined ? {} : { resolve: inputOptions.resolve }),
          ...(config.define === undefined ? {} : { transform: { define: config.define } }),
          plugins: config.plugins,
        });
        try {
          const { output } = await build.generate({ format: "cjs", codeSplitting: false });
          const chunk = output.find((item) => item.type === "chunk");
          if (chunk === undefined || chunk.type !== "chunk") throw new Error("no client chunk");
          expect(styleImports(chunk.code)).toEqual([]);
          expect(chunk.code).toContain(`data-plugin-css=\\"${PLUGIN_ID}/Fixture.module.css\\"`);
          expect(chunk.code).toMatch(/"[A-Za-z0-9_-]+_root"/);
        } finally {
          await build.close();
        }
      } finally {
        process.chdir(cwd);
      }
    });
  });
});
