import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const UPSTREAM_PRESETS = join(
  dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-agent-presets/package.json"))),
  "presets",
);

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

function generatedHeader(): string {
  return `# 本文件由 packages/dsh-preset/tool/generate-presets.ts 生成，请勿手工编辑
`;
}

interface CompositionRow {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export const PERSONA_ROW_ID = "persona";

export const INSTRUCTIONS_ROW_ID = "agent-instructions";

export const INSTRUCTIONS_CONFIG = {
  instructionFileCandidates: ["AGENTS.md"],
  localInstructionFileCandidates: ["AGENTS.local.md"],
} as const;

export function renderComposition(upstream: string): string {
  const rows = yaml.load(upstream, {
    schema: entryListSchema,
  }) as CompositionRow[];

  const persona = rows.findIndex((row) => row.id === PERSONA_ROW_ID);
  if (persona >= 0) rows.splice(persona, 1);
  const instructions = rows.find((row) => row.id === INSTRUCTIONS_ROW_ID);
  if (instructions === undefined) {
    throw new Error(
      `generate-presets: upstream composition has no \`${INSTRUCTIONS_ROW_ID}\` row; ` +
        "upstream changed — re-check which plugin loads the workspace instructions",
    );
  }
  instructions.config = { ...instructions.config, ...INSTRUCTIONS_CONFIG };

  const body = yaml.dump(rows, {
    schema: entryListSchema,
    lineWidth: -1,
    quotingType: '"',
  });
  return `${generatedHeader()}${body}`;
}

export function renderMetadata(entry: (typeof PRESET_SOURCES)[number]): string {
  return `name: ${entry.name}\ndescription: ${entry.description}\norder: ${String(entry.order)}\n`;
}

export const PRESETS_OUT_DIR = "dist/presets";

export async function generatePresets(
  outDir: string = join(PACKAGE_ROOT, PRESETS_OUT_DIR),
): Promise<string[]> {
  await rm(outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const entry of PRESET_SOURCES) {
    const upstream = await readFile(
      join(UPSTREAM_PRESETS, entry.source, "agent.cordis.yml"),
      "utf8",
    );

    const dir = join(outDir, entry.source);
    await mkdir(dir, { recursive: true });
    const compositionPath = join(dir, "agent.cordis.yml");
    await writeFile(compositionPath, renderComposition(upstream));
    const metadataPath = join(dir, "preset.yml");
    await writeFile(metadataPath, renderMetadata(entry));
    written.push(compositionPath, metadataPath);
  }
  return written;
}

export function presetHooks(): {
  "build:done": (ctx: { options: { outDir: string } }) => Promise<void>;
} {
  return {
    "build:done": async (ctx) => {
      const written = await generatePresets(join(ctx.options.outDir, "presets"));
      for (const path of written) process.stdout.write(`generated ${path}\n`);
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2];
  for (const path of await generatePresets(outDir)) {
    process.stdout.write(`generated ${path}\n`);
  }
}
