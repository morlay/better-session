/**
 * 生成产物的回归测试：`dist/presets/standard` / `dist/presets/ptc` 必须等于
 * 「上游 composition 删 persona 行、指令候选收紧为 AGENTS 系列」的版本。
 *
 * 断言方式是把产物与**现算的**期望值比较，而不是与一份快照比——上游升级后
 * 忘记重跑构建时，这条测试会失败并指出 drift，而不是继续绿着。期望值由测试
 * 自己解析上游推出、不经过被测的 `renderComposition`：生成器多删 / 改任何
 * 一行都会失败，而不是自证。
 *
 * 产物在 dist（构建输出，gitignore），因此测试自身调用 `generatePresets` 到
 * 临时目录，不依赖 build 是否跑过。
 * @module @morlay/dsh-preset/__tests__/generated-presets
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import {
  PRESET_SOURCES,
  PERSONA_ROW_ID,
  UPSTREAM_PRESETS,
  generatePresets,
  renderMetadata,
} from "../../tool/generate-presets.ts";

/** 上游 preset 里承载工作区指令的行 id。 */
const INSTRUCTIONS_ROW_ID = "agent-instructions";

/** 上游那行指向的官方插件（fork 暂未接入，产物须保持官方名）。 */
const UPSTREAM_INSTRUCTIONS_PLUGIN = "@deepseek-ai/dsh-agent-instructions";

/** 产物里指令候选的文件名（字面量：不读 CLAUDE 系列）。 */
const PRODUCT_INSTRUCTION_CANDIDATES = ["AGENTS.md"];
const PRODUCT_LOCAL_INSTRUCTION_CANDIDATES = ["AGENTS.local.md"];

/** 上游 composition 的一行；比较只看结构。 */
type CompositionRow = {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

const OUT_DIR = mkdtempSync(join(tmpdir(), "dsh-preset-"));
afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});
generatePresets(OUT_DIR);

/** 独立解析 composition 文本（include 的 schema，`!!js` 标签保留为表达式节点）。 */
function parseRows(text: string): CompositionRow[] {
  return yaml.load(text, { schema: entryListSchema }) as CompositionRow[];
}

/** 解析上游 preset 与生成产物。 */
function readPair(source: string): { upstream: CompositionRow[]; product: CompositionRow[] } {
  return {
    upstream: parseRows(readFileSync(join(UPSTREAM_PRESETS, source, "agent.cordis.yml"), "utf8")),
    product: parseRows(readFileSync(join(OUT_DIR, source, "agent.cordis.yml"), "utf8")),
  };
}

/** 生成器对上游 composition 的期望改动：删 persona 行、收紧指令候选。 */
function expectedRows(upstream: CompositionRow[]): CompositionRow[] {
  return upstream
    .filter((row) => row.id !== PERSONA_ROW_ID)
    .map((row) =>
      row.id === INSTRUCTIONS_ROW_ID
        ? {
            ...row,
            config: {
              ...row.config,
              instructionFileCandidates: PRODUCT_INSTRUCTION_CANDIDATES,
              localInstructionFileCandidates: PRODUCT_LOCAL_INSTRUCTION_CANDIDATES,
            },
          }
        : row,
    );
}

describe("generated presets", () => {
  it.each(PRESET_SOURCES)(
    "$source equals its upstream source with only the persona row dropped and the instruction candidates narrowed",
    (entry) => {
      const { upstream, product } = readPair(entry.source);
      // 期望由测试自行推出：上游删 persona 行 + 收紧候选，其余逐行不动。
      expect(product).toEqual(expectedRows(upstream));
    },
  );

  it.each(PRESET_SOURCES)(
    "$source keeps the agent-instructions row on the upstream plugin with AGENTS-only candidates",
    (entry) => {
      const { upstream, product } = readPair(entry.source);
      const upstreamRow = upstream.find((row) => row.id === INSTRUCTIONS_ROW_ID);
      const productRow = product.find((row) => row.id === INSTRUCTIONS_ROW_ID);
      // 官方插件名保持（fork 一旦接入即失败，改名也不失效）。
      expect(upstreamRow?.name).toBe(UPSTREAM_INSTRUCTIONS_PLUGIN);
      expect(productRow?.name).toBe(upstreamRow?.name);
      // 候选收紧为 AGENTS 系列：CLAUDE 系列不再被读取。
      expect(productRow?.config?.instructionFileCandidates).toEqual(["AGENTS.md"]);
      expect(productRow?.config?.localInstructionFileCandidates).toEqual(["AGENTS.local.md"]);
      // 其余 config 字段跟随上游（如 maxBytes 的字节预算）。
      expect(productRow?.config?.maxBytes).toBe(upstreamRow?.config?.maxBytes);
      // 产物里不应出现本仓库的插件行。
      expect(
        product.some((row) => typeof row.name === "string" && row.name.startsWith("@morlay/")),
      ).toBe(false);
    },
  );

  it.each(PRESET_SOURCES)("$source carries generated metadata", (entry) => {
    const actual = readFileSync(join(OUT_DIR, entry.source, "preset.yml"), "utf8");
    expect(actual).toBe(renderMetadata(entry));
    // 字段级校验：多写 / 漏写字段在这里失败（上面的逐字比较是自指的）。
    expect(yaml.load(actual)).toEqual({
      name: entry.name,
      description: entry.description,
      order: entry.order,
    });
  });

  it("drops the persona row: the deployment system-prompt owns the persona", () => {
    for (const entry of PRESET_SOURCES) {
      const text = readFileSync(join(OUT_DIR, entry.source, "agent.cordis.yml"), "utf8");
      // preset 自带 persona 行会在 agent scope 遮蔽部署级 persona（system-prompt 的
      // personaPrefix），所以产物里不能有它。
      expect(text).not.toContain(`- id: ${PERSONA_ROW_ID}\n`);
      expect(text).not.toContain("You are a coding agent powered by the {{model}} model.");
    }
  });

  it("the output dir holds nothing beyond the generated sources", () => {
    const expected = PRESET_SOURCES.map((entry) => entry.source).sort();
    const actual = readdirSync(OUT_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();
    expect(actual).toEqual(expected);
  });

  it("clears stale directories from a previous generation", () => {
    // 同目录再生成一次，且先塞一个残留目录：它必须消失。
    mkdirSync(join(OUT_DIR, "stale"), { recursive: true });
    generatePresets(OUT_DIR);
    expect(readdirSync(OUT_DIR)).not.toContain("stale");
  });
});
