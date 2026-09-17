// @vitest-environment jsdom
// fork 差异点（docs/debt/0001）：scoped slash 事件归一（引用落裸 URI 纯文本、skill 落
// skill: token）+ 会话 cwd 注入到工作区相对化。
import { Context } from "@deepseek-ai/cordis";
import type {
  ISessions,
  SessionBinding,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReferenceInsert } from "../client/contract/draft-editor.ts";
import type { QueuedMessage } from "../client/contract/input.ts";
import type { SessionInputShell } from "../client/input/facade.ts";
import { InputHub } from "../client/input/hub.ts";

const SID = "s1" as SessionId;
const CWD = "/w/proj";

const FILE_INSERT: ReferenceInsert = {
  source: "reference",
  ref: "@src/a.ts",
  label: "a.ts",
  appearance: "file",
  clipboardText: "file:src/a.ts",
};

const t = ((key: string) => key) as unknown as TranslateNS<"conversation">;

interface Bench {
  hub: InputHub;
  actx: Context;
  shell: SessionInputShell;
  session: { queue: QueuedMessage[]; updateQueue: ReturnType<typeof vi.fn> };
  emit: (name: string, payload: unknown) => void;
}

const disposed: (() => void)[] = [];

function bench(options: { cwd?: string | undefined; queue?: QueuedMessage[] } = {}): Bench {
  const session = {
    queue: options.queue ?? [],
    updateQueue: vi.fn(async () => ({ ok: true })),
  };
  const face = {
    getSnapshot: () => ({ queue: session.queue }),
    subscribe: () => () => {},
    updateQueue: session.updateQueue,
    readAttachment: async () => ({ ok: false }),
  } as unknown as SessionFace;
  const actx = new Context();
  const binding: SessionBinding = {
    sessionId: SID,
    session: face,
    eventSource: {
      getSnapshot: () => ({
        entries: [],
        hasMore: false,
        revision: 0,
        change: { kind: "replace", entries: [] },
      }),
      subscribe: () => () => {},
    },
    ctx: actx as SessionBinding["ctx"],
  };
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: [SID],
        byId: { [SID]: { cwd: options.cwd ?? CWD } },
        current: SID,
        phase: "ready",
        subagentsByParent: {},
        jobsBySession: {},
        currentAddress: undefined,
      }),
      subscribe: () => () => {},
    },
    scopeOf: (ctx: Context) => (ctx === actx ? SID : undefined),
    binding: (id: SessionId) => (id === SID ? binding : undefined),
    scope: (id: SessionId) => (id === SID ? actx : undefined),
  } as unknown as ISessions;
  const rootCtx = new Context();
  rootCtx.provide("sessions", sessions);
  rootCtx.provide("conversation", {
    serializeDraftAttachments: async () => ({ attachments: [] }),
    releaseDraftAttachment: () => {},
    sendSession: async () => ({ kind: "success" }),
  });
  const hub = new InputHub(rootCtx, t);
  const shell = hub.shellFor(binding);
  disposed.push(() => {
    shell.dispose();
    void rootCtx.fiber.dispose();
    void actx.fiber.dispose();
  });
  return {
    hub,
    actx,
    shell,
    session,
    emit: (name, payload) => {
      (actx as unknown as { emit: (event: string, input: unknown) => unknown }).emit(name, payload);
    },
  };
}

function spanOf(shell: SessionInputShell, end = shell.snapshot.draft.length) {
  return { start: 0, end, draftRev: shell.snapshot.draftRev };
}

afterEach(() => {
  for (const dispose of disposed.splice(0)) dispose();
});

describe("InputHub: cwd 注入", () => {
  it("用会话列表里的 cwd 相对化工作区内的绝对路径", () => {
    const { shell } = bench({ cwd: "/w/proj" });
    expect(shell.clipboardUri("/w/proj/src/a.ts")).toBe("src/a.ts");
  });

  it("会话没有 cwd 时保持绝对路径", () => {
    const { shell } = bench({ cwd: "" });
    expect(shell.clipboardUri("/w/proj/src/a.ts")).toBe("/w/proj/src/a.ts");
  });
});

describe("InputHub: scoped slash 事件归一", () => {
  it("插入引用事件把引用落成裸 URI 纯文本", () => {
    const { shell, emit } = bench();
    shell.setDraft("@src/");
    emit("slash/input-insert-reference", { reference: FILE_INSERT, span: spanOf(shell, 5) });

    expect(shell.snapshot.draft).toBe("file:src/a.ts ");
    expect(shell.snapshot.occurrences).toEqual([]);
  });

  it("插入文本事件把 skill 令牌落成 skill: token", () => {
    const { shell, emit } = bench();
    shell.setDraft("/code-review");
    emit("slash/input-insert-text", { text: "/code-review ", span: spanOf(shell, 12) });

    expect(shell.snapshot.draft).toBe("skill:code-review ");
  });

  it("消费令牌事件按 bare-token guard 清空草稿", () => {
    const { shell, emit } = bench();
    shell.setDraft("/goal");
    emit("slash/input-consume-token", { guard: { kind: "bare-token", token: "/goal" } });

    expect(shell.snapshot.draft).toBe("");
  });
});

describe("InputHub: 会话 shell 复用与寻址", () => {
  it("同一会话复用同一个 shell 实例", () => {
    const { hub, shell } = bench();
    expect(hub.shell(SID)).toBe(shell);
    expect(hub.keyboard(SID)).toBe(shell);
  });

  it("未知会话寻址失败", () => {
    const { hub } = bench();
    expect(() => hub.shell("nope" as SessionId)).toThrow(/nope/u);
  });
});

describe("InputHub: 队列插话", () => {
  it("把排队中的行逐条交给会话的 steer 动作", async () => {
    const queued = { id: "q1", placement: "queued" } as unknown as QueuedMessage;
    const { shell, session } = bench({ queue: [queued] });
    shell.steerQueue();

    await vi.waitFor(() => {
      expect(session.updateQueue).toHaveBeenCalledWith("q1", { kind: "steer" });
    });
  });

  it("插话不可用时静默返回，不产生错误提示", async () => {
    const queued = { id: "q1", placement: "queued" } as unknown as QueuedMessage;
    const { shell, session } = bench({ queue: [queued] });
    session.updateQueue.mockResolvedValue({
      ok: false,
      error: { code: "session/steer-unavailable", message: "busy" },
    });
    shell.steerQueue();

    await vi.waitFor(() => {
      expect(session.updateQueue).toHaveBeenCalledTimes(1);
    });
    expect(shell.notices.getSnapshot()).toBeNull();
  });

  it("其它失败原因给出错误提示", async () => {
    const queued = { id: "q1", placement: "queued" } as unknown as QueuedMessage;
    const { shell, session } = bench({ queue: [queued] });
    session.updateQueue.mockResolvedValue({
      ok: false,
      error: { code: "session/transport", message: "boom" },
    });
    shell.steerQueue();

    await vi.waitFor(() => {
      expect(shell.notices.getSnapshot()).toMatchObject({ level: "error" });
    });
  });
});
