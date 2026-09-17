import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

const INSTRUCTIONS_ROW_ID = "agent-instructions";

const UPSTREAM_INSTRUCTIONS_PLUGIN = "@deepseek-ai/dsh-agent-instructions";

const PRODUCT_INSTRUCTION_CANDIDATES = ["AGENTS.md"];
const PRODUCT_LOCAL_INSTRUCTION_CANDIDATES = ["AGENTS.local.md"];

type CompositionRow = {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

const OUT_DIR = await mkdtemp(join(tmpdir(), "dsh-preset-"));
afterAll(async () => {
  await rm(OUT_DIR, { recursive: true, force: true });
});
await generatePresets(OUT_DIR);

function parseRows(text: string): CompositionRow[] {
  return yaml.load(text, { schema: entryListSchema }) as CompositionRow[];
}

async function readPair(
  source: string,
): Promise<{ upstream: CompositionRow[]; product: CompositionRow[] }> {
  return {
    upstream: parseRows(await readFile(join(UPSTREAM_PRESETS, source, "agent.cordis.yml"), "utf8")),
    product: parseRows(await readFile(join(OUT_DIR, source, "agent.cordis.yml"), "utf8")),
  };
}

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
    async (entry) => {
      const { upstream, product } = await readPair(entry.source);

      expect(product).toEqual(expectedRows(upstream));
    },
  );

  it.each(PRESET_SOURCES)(
    "$source keeps the agent-instructions row on the upstream plugin with AGENTS-only candidates",
    async (entry) => {
      const { upstream, product } = await readPair(entry.source);
      const upstreamRow = upstream.find((row) => row.id === INSTRUCTIONS_ROW_ID);
      const productRow = product.find((row) => row.id === INSTRUCTIONS_ROW_ID);

      expect(upstreamRow?.name).toBe(UPSTREAM_INSTRUCTIONS_PLUGIN);
      expect(productRow?.name).toBe(upstreamRow?.name);

      expect(productRow?.config?.instructionFileCandidates).toEqual(["AGENTS.md"]);
      expect(productRow?.config?.localInstructionFileCandidates).toEqual(["AGENTS.local.md"]);

      expect(productRow?.config?.maxBytes).toBe(upstreamRow?.config?.maxBytes);

      expect(
        product.some((row) => typeof row.name === "string" && row.name.startsWith("@morlay/")),
      ).toBe(false);
    },
  );

  it.each(PRESET_SOURCES)("$source carries generated metadata", async (entry) => {
    const actual = await readFile(join(OUT_DIR, entry.source, "preset.yml"), "utf8");
    expect(actual).toBe(renderMetadata(entry));

    expect(yaml.load(actual)).toEqual({
      name: entry.name,
      description: entry.description,
      order: entry.order,
    });
  });

  it("drops the persona row: the deployment system-prompt owns the persona", async () => {
    for (const entry of PRESET_SOURCES) {
      const text = await readFile(join(OUT_DIR, entry.source, "agent.cordis.yml"), "utf8");

      expect(text).not.toContain(`- id: ${PERSONA_ROW_ID}\n`);
      expect(text).not.toContain("You are a coding agent powered by the {{model}} model.");
    }
  });

  it("the output dir holds nothing beyond the generated sources", async () => {
    const expected = PRESET_SOURCES.map((entry) => entry.source).sort();
    const actual = (await readdir(OUT_DIR, { withFileTypes: true }))
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();
    expect(actual).toEqual(expected);
  });

  it("clears stale directories from a previous generation", async () => {
    await mkdir(join(OUT_DIR, "stale"), { recursive: true });
    await generatePresets(OUT_DIR);
    expect(await readdir(OUT_DIR)).not.toContain("stale");
  });
});
