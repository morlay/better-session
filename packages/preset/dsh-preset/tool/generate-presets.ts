/**
 * 从上游 shipped preset 生成自定义 preset 到构建输出目录（`dist/presets/standard`
 * 与 `dist/presets/ptc`）。
 *
 * 为什么是生成而非复制：preset 是运行期被 discovery 扫描的 composition，
 * 必须随包发布；但手工维护副本会与上游 drift。这里把上游 `standard` / `ptc`
 * 当数据读入——`js-yaml` 用 include 的 `entryListSchema` 解析（`!!js` 标签
 * 因此保留为表达式节点）——在 JS 里 map 出 `persona` 行并替换 prefix，再
 * `dump` 回 YAML。上游任何结构性改动（新增/重命名 row、改字段）都自动跟随，
 * 不依赖易碎的文本锚点。
 *
 * 产物落在 `dist/` 而非源码树：dist 是构建输出（gitignore），既不会与 oxfmt
 * 互相改格式，也不会把派生文件混进源码。
 *
 * 代价：`dump` 不保留注释（上游 composition 的说明注释会丢）。
 *
 * 用法：由 `tsdown.config.ts` 的 `build:done` hook 在每次构建时调用
 * （见 {@link presetHooks}）；也可单独跑
 * `pnpm exec tsx packages/dsh-preset/tool/generate-presets.ts [outDir]`。
 * 校验：`packages/dsh-preset/src/__tests__/generated-presets.spec.ts`
 * @module @morlay/dsh-preset/tool/generate-presets
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 上游 shipped preset 根目录：经上游包（devDependency）解析，不依赖仓库布局。
// 子目录不在上游 exports 内，故从 `package.json`（exports 显式导出）起拼。
export const UPSTREAM_PRESETS = join(
  dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-agent-presets/package.json"))),
  "presets",
);

/** 个人 persona：替换上游 preset 的部署级默认。 */
export const PERSONA_PREFIX = [
  "你是一个经验丰富的编程专家，YAGNI 是你的编程哲学，PDCA 是你的行为规范",
  "",
  "## 语言与行为",
  "",
  "- 所有思考、分析、推理过程、工具调用描述等必须使用中文，专有名词除外",
  "- 思考不要陷入重复循环，一旦循环，立即退出",
  "- 思考聚焦需求理解与方案设计（要点、流程、验证策略），不预演具体代码实现；代码在 Do 阶段基于实际文件状态输出，正确性由 Check 验证。",
].join("\n");

/** 每个自定义 preset：上游源 preset（同时是产物目录名）与展示元数据。 */
export const PRESET_SOURCES = [
  {
    source: "standard",
    name: "标准模式",
    description:
      "功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。",
    order: 1,
  },
  {
    source: "ptc",
    name: "PTC 模式",
    description:
      "功能完整的编码 Agent，但默认不提供 workflow 工具；其他工具通过 PTC 模式 SDK 呈现，让模型用一个 TypeScript 程序组合多步操作。",
    order: 2,
  },
] as const;

/** 生成产物顶部的来源标注，插在文件最前，便于核对与追溯。 */
function generatedHeader(): string {
  return `# 本文件由 packages/dsh-preset/tool/generate-presets.ts 生成，请勿手工编辑
`;
}

/** 上游 composition 的一行；只用到 id 与 config.prefix。 */
interface CompositionRow {
  id?: string;
  config?: { prefix?: string } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 把上游 composition 文本渲染成产物文本：解析 → map persona → dump。
 * @param source - 上游 preset id，用于 header 与诊断。
 * @param upstream - 上游 composition 文本。
 * @returns 带 header 的产物文本。
 */
export function renderComposition(source: string, upstream: string): string {
  const rows = yaml.load(upstream, {
    schema: entryListSchema,
  }) as CompositionRow[];
  const persona = rows.find((row) => row.id === "persona");
  if (persona?.config === undefined) {
    throw new Error(
      `generate-presets: upstream \`${source}\` has no \`persona\` row with a config; ` +
        "upstream changed — re-check how this preset declares its persona",
    );
  }
  persona.config.prefix = PERSONA_PREFIX;
  // `quotingType: '"'` 是刻意选择：yaml.dump 默认用单引号，而仓库的 oxfmt 会把
  // YAML 单引号改成双引号——不显式指定就会 fmt 与生成器来回改。指定后产物与
  // `oxfmt --check` 零差异（实测），故 `presets/**` 无需 fmt 忽略。
  const body = yaml.dump(rows, {
    schema: entryListSchema,
    lineWidth: -1,
    quotingType: '"',
  });
  return `${generatedHeader()}${body}`;
}

/** 渲染 preset.yml 展示元数据（自定义 id 不走内置文案 fold）。 */
export function renderMetadata(entry: (typeof PRESET_SOURCES)[number]): string {
  return `name: ${entry.name}\ndescription: ${entry.description}\norder: ${String(entry.order)}\n`;
}

/** 生成目录相对包根的默认位置（构建输出，随 files 发布）。 */
export const PRESETS_OUT_DIR = "dist/presets";

/**
 * 生成全部自定义 preset 到 `outDir`。
 * @param outDir - 输出目录绝对路径；缺省为包根下的 {@link PRESETS_OUT_DIR}。
 * @returns 产物文件路径列表。
 */
export function generatePresets(outDir: string = join(PACKAGE_ROOT, PRESETS_OUT_DIR)): string[] {
  // 先整目录清空：产物完全派生自本脚本，残留目录（改过 source、旧命名）不该留下
  // ——否则 discovery 会把它们当有效 preset 扫出来。
  rmSync(outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const entry of PRESET_SOURCES) {
    const upstream = readFileSync(join(UPSTREAM_PRESETS, entry.source, "agent.cordis.yml"), "utf8");
    // 产物目录名 = 上游 preset id：canonical id 让展示名走客户端语言字典
    // （`presetDisplayText` 对 trust=system 且 id 命中的行做本地化）。
    const dir = join(outDir, entry.source);
    mkdirSync(dir, { recursive: true });
    const compositionPath = join(dir, "agent.cordis.yml");
    writeFileSync(compositionPath, renderComposition(entry.source, upstream));
    const metadataPath = join(dir, "preset.yml");
    writeFileSync(metadataPath, renderMetadata(entry));
    written.push(compositionPath, metadataPath);
  }
  return written;
}

/**
 * tsdown hooks：构建完成后把 preset 生成到构建输出目录。
 *
 * 必须挂 `build:done` 而不是 `build:prepare`——tsdown 的时序是
 * `build:prepare` → `clean()`（清空 outDir）→ rolldown → `build:done`，
 * 在 clean 之前写会被删掉。挂在 done 上则产物与 JS/d.ts 同批产出。
 * @returns 供 `UserConfig.hooks` 使用的 hook 集合。
 */
export function presetHooks(): {
  "build:done": (ctx: { options: { outDir: string } }) => void;
} {
  return {
    "build:done": (ctx) => {
      // 用 tsdown 解析后的 outDir（尊重用户覆盖），而非硬编码 dist。
      const written = generatePresets(join(ctx.options.outDir, "presets"));
      for (const path of written) process.stdout.write(`generated ${path}\n`);
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2];
  for (const path of generatePresets(outDir)) {
    process.stdout.write(`generated ${path}\n`);
  }
}
