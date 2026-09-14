// 装配守卫：prompt-reminder 是 host plane 的唯一装配点。被误删 / 改名时提示词分层
// 静默失效（工具说明回到系统提示词），这里 fail loud；persona 是 keep 名单的唯一
// 提供者，删掉它系统提示词会变空。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const PATCH_PATH = join(process.cwd(), "packages/preset/dsh-preset/cordis.patch.yml");

/** patch 的一行；只用到覆盖目标与 insert 的新增行。 */
interface PatchRow {
  id?: string;
  config?: Record<string, unknown>;
  insert?: { id?: string; name?: string }[];
}

// 用 include 的 entry schema 解析：patch 里含 `!!js` 表达式，默认 schema 会拒绝。
const rows = yaml.load(readFileSync(PATCH_PATH, "utf8"), {
  schema: entryListSchema,
}) as PatchRow[];

describe("dsh-preset patch wiring", () => {
  it("declares the prompt-reminder row exactly once, on the local plugin", () => {
    const inserted = rows
      .flatMap((row) => row.insert ?? [])
      .filter((row) => row.id === "prompt-reminder");

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.name).toBe("@morlay/dsh-prompt-reminder");
  });

  it("keeps the deployment persona the reminder keeps in the system prompt", () => {
    const config = rows.find((row) => row.id === "system-prompt")?.config;

    expect(config?.personaPrefix).toBeTruthy();
    expect(config?.personaSuffix).toBeTruthy();
  });
});
