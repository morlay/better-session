/**
 * 增量协调的可见状态来源：baseline 的 scope 现在从 system prompt 的标记重建，
 * 因此它不会在后续 pre-step 里被当成新变更重复注入；文件真的变了仍会产出
 * user 消息提醒。
 * @module @morlay/dsh-agent-instructions-as-prompt/__tests__/reconcile
 */

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import SessionStore, { SessionId, type Session } from "@deepseek-ai/dsh-session";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.ts";
import { promptBaselines } from "../prompt.ts";
import { reconcileInstructionContext, type InstructionVersionCache } from "../state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const resolved = resolveConfig({ maxBytes: 65536, projectRootMarkers: [".git"] });

/** 临时项目 + 真实 Session（cwd 指向项目根）。 */
async function mount(content: string): Promise<{ root: string; session: Session; fs: unknown }> {
  const root = mkdtempSync(join(tmpdir(), "reconcile-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), content);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(LocalFileSystem, { cwd: "/" });
  const session = ctx.sessions.create(SessionId(`reconcile-${Date.now()}-${Math.random()}`), {
    meta: { cwd: root },
  });
  return { root, session, fs: ctx.get("fs") };
}

/** 记下一次 system prompt 注入：本进程的快照（等价于上一轮装配的结果）。 */
function commitPrompt(session: Session, content: string): void {
  promptBaselines.set(session, {
    identity: "identity-1",
    files: [
      {
        absolutePath: join(session.header.cwd ?? "", "AGENTS.md"),
        displayPath: "AGENTS.md",
        content,
      },
    ],
  });
}

async function reconcile(
  session: Session,
  fs: unknown,
  includeBaselineScopes: boolean,
  cache: InstructionVersionCache = new WeakMap(),
) {
  return reconcileInstructionContext(
    { session } as unknown as Agent,
    resolved,
    cache,
    fs as never,
    {
      authorityMessages: [],
      scopeMessages: [],
      touchedPaths: [],
      includeBaselineScopes,
      projectRoot: session.header.cwd ?? "",
    },
  );
}

describe("baseline visibility", () => {
  it("does not re-emit a baseline the system prompt already carries", async () => {
    const { session, fs } = await mount("# 规则\n\nYAGNI。");
    commitPrompt(session, "# 规则\n\nYAGNI。");

    expect(await reconcile(session, fs, true)).toBeUndefined();
  });

  it("emits the baseline when nothing visible carries it", async () => {
    const { session, fs } = await mount("# 规则\n\nYAGNI。");

    const result = await reconcile(session, fs, true);

    expect(result?.context.source).toMatchObject({ kind: "agent-instructions" });
  });

  it("still reports a changed instruction file", async () => {
    const { root, session, fs } = await mount("# 规则");
    commitPrompt(session, "# 规则");

    writeFileSync(join(root, "AGENTS.md"), "# 改过的规则");
    const result = await reconcile(session, fs, true);

    expect(result?.context.source).toMatchObject({
      changes: [{ action: "replace", path: "AGENTS.md" }],
    });
  });
});
