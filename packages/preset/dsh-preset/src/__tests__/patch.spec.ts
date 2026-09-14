// 装配守卫：prompt-reminder 是 host plane 的唯一装配点。被误删 / 改名时提示词分层
// 静默失效（工具说明回到系统提示词），这里 fail loud；persona 是 keep 名单的唯一
// 提供者，删掉它系统提示词会变空。
//
// 沙箱同理：官方 `sandbox` / `fs-sandbox` 的禁用与本包 `sandbox-local` 行的插入必须在
// 同一层——官方行还在时 `ctx.sandbox` / `ctx.fs` 由官方实现提供，access 规则没有生效点，
// 命令照跑但规则全部失效（只剩 workspace + /tmp 可写），且没有任何报错。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const PATCH_PATH = join(process.cwd(), "packages/preset/dsh-preset/cordis.patch.yml");
const UPSTREAM_BASE_PATCH = join(
  process.cwd(),
  "vendor/deepseek-harness/packages/bundle/base/cordis.patch.yml",
);

/** patch 的一行；只用到覆盖目标、禁用与 insert 的新增行。 */
interface PatchRow {
  id?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  insert?: { id?: string; name?: string; config?: Record<string, unknown> }[];
}

// 用 include 的 entry schema 解析：patch 里含 `!!js` 表达式，默认 schema 会拒绝。
const rows = yaml.load(readFileSync(PATCH_PATH, "utf8"), {
  schema: entryListSchema,
}) as PatchRow[];

/** 本层 insert 出来的行。 */
const inserted = rows.flatMap((row) => row.insert ?? []);

/** 本层的 `sandbox-local` 行（装配沙箱替换的那个）。 */
const sandboxRow = inserted.find((row) => row.id === "sandbox-local");

describe("dsh-preset patch wiring", () => {
  it("declares the prompt-reminder row exactly once, on the local plugin", () => {
    const reminders = inserted.filter((row) => row.id === "prompt-reminder");

    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.name).toBe("@morlay/dsh-prompt-reminder");
  });

  it("keeps the deployment persona the reminder keeps in the system prompt", () => {
    const config = rows.find((row) => row.id === "system-prompt")?.config;

    expect(config?.personaPrefix).toBeTruthy();
    expect(config?.personaSuffix).toBeTruthy();
  });

  it("disables the shipped sandbox rows and mounts the replacement in one layer", () => {
    expect(rows.filter((row) => row.disabled === true).map((row) => row.id)).toEqual([
      "sandbox",
      "fs-sandbox",
    ]);
    expect(inserted.filter((row) => row.id === "sandbox-local")).toHaveLength(1);
    expect(sandboxRow?.name).toBe("@morlay/dsh-sandbox-local");
  });

  it("names rows that still exist in the shipped base bundle", () => {
    // 上游改名或移动这两行时，本层的 disabled 会被 include 静默跳过（warn+skip），
    // 沙箱替换随之失效；这里对着 vendor 里的 base patch 校验一次。
    const upstreamIds = new Set(
      [...readFileSync(UPSTREAM_BASE_PATCH, "utf8").matchAll(/^\s*- id: (\S+)$/gm)].map(
        (match) => match[1]!,
      ),
    );

    for (const id of ["sandbox", "fs-sandbox"]) {
      expect(upstreamIds.has(id), `missing upstream row: ${id}`).toBe(true);
    }
  });

  it("carries the deployment sandbox rules on the inserted row", () => {
    // 规则随本 bundle 分发（跨 dev / 打包形态一致），不再依赖另一层 bundle。
    const access = sandboxRow?.config?.access;

    expect(typeof access).toBe("string");
    expect(String(access)).toContain("rw {{ env.XDG_CACHE_HOME }}");
    expect(String(access)).toContain("rw {{ env.XDG_DATA_HOME }}");
    expect(String(access)).toContain("-- mise.*.toml");
    expect(String(access)).toContain("-- **/*.pem");
  });

  it("depends on the bundle whose service classes the inserted row mounts", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "packages/preset/dsh-preset/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.["@morlay/dsh-sandbox-local"]).toBeTruthy();
  });
});
