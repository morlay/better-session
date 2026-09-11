/**
 * 生成产物的回归测试：`dist/presets/standard` / `dist/presets/ptc` 必须等于
 * 「上游 composition 的 persona prefix 替换版」。
 *
 * 断言方式是把产物与**现算的**期望值比较，而不是与一份快照比——上游升级后
 * 忘记重跑构建时，这条测试会失败并指出 drift，而不是继续绿着。
 *
 * 产物在 dist（构建输出，gitignore），因此测试自身调用 `generatePresets` 到
 * 临时目录，不依赖 build 是否跑过。
 * @module @morlay/dsh-preset/__tests__/generated-presets
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PRESET_SOURCES,
  INSTRUCTIONS_PLUGIN,
  PERSONA_ROW_ID,
  UPSTREAM_PRESETS,
  generatePresets,
  renderComposition,
  renderMetadata,
} from "../../tool/generate-presets.ts";

const OUT_DIR = mkdtempSync(join(tmpdir(), "dsh-preset-"));
afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});
generatePresets(OUT_DIR);

describe("generated presets", () => {
  it.each(PRESET_SOURCES)(
    "$source matches its upstream source with only the persona and instructions rows replaced",
    (entry) => {
      const upstream = readFileSync(
        join(UPSTREAM_PRESETS, entry.source, "agent.cordis.yml"),
        "utf8",
      );
      const actual = readFileSync(join(OUT_DIR, entry.source, "agent.cordis.yml"), "utf8");
      expect(actual).toBe(renderComposition(entry.source, upstream));
    },
  );

  it.each(PRESET_SOURCES)("$source loads the fork for workspace instructions", (entry) => {
    const text = readFileSync(join(OUT_DIR, entry.source, "agent.cordis.yml"), "utf8");
    // preset 是会话级 composition：不在这里换掉，上游插件仍会把 baseline 作为
    // user 消息注入一次（profile 级的 disable 管不到 preset）。
    expect(text).toContain(`name: "${INSTRUCTIONS_PLUGIN}"`);
    expect(text).not.toContain('"@deepseek-ai/dsh-agent-instructions"');
  });

  it.each(PRESET_SOURCES)("$source carries generated metadata", (entry) => {
    const actual = readFileSync(join(OUT_DIR, entry.source, "preset.yml"), "utf8");
    expect(actual).toBe(renderMetadata(entry));
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
