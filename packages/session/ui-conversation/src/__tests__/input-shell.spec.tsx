// @vitest-environment jsdom
// fork 差异点（见本包 .agents/debts/20260917-临时接管上游对话UI的client半.md）：引用插入走纯文本、提交回上游 sink、restoreDraft 收窄、
// cwd 注入。接缝是 SessionInputShell 的公开面（SessionInput / ComposerKeyboard）。
import { Context } from "@deepseek-ai/cordis";
import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReferenceInsert, TokenSpan } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/draft-editor.ts";
import type { InputSubmitMode } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/composer-submission.ts";
import type {
  DraftAttachmentId,
  InputTriggerController,
  SubmitOutcome,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/input.ts";
import { SessionInputShell } from "../client/input/facade.ts";

const FILE_INSERT: ReferenceInsert = {
  source: "reference",
  ref: "@src/a.ts",
  label: "a.ts",
  appearance: "file",
  clipboardText: "file:src/a.ts",
};

const EMPTY_LEXICON: ObservableSnapshot<ReadonlyMap<"/" | "@", readonly string[]>> = {
  getSnapshot: () => new Map(),
  subscribe: () => () => {},
};

function stubTriggers(overrides: Partial<InputTriggerController> = {}): InputTriggerController {
  return {
    launcher: { getSnapshot: () => null, subscribe: () => () => {} },
    lexicon: EMPTY_LEXICON,
    track: () => {},
    arbitrate: () => "pass",
    onSpace: () => false,
    serializeReference: async () => "",
    adjudicate: async () => undefined,
    openReference: () => false,
    toggleSource: () => {},
    ...overrides,
  };
}

interface BenchOptions {
  sink?: (text: string, ids: readonly DraftAttachmentId[]) => SubmitOutcome;
  cwd?: string;
  triggers?: Partial<InputTriggerController>;
}

const created: SessionInputShell[] = [];

function bench(options: BenchOptions = {}) {
  const sink = vi.fn(
    async (
      ...args: [
        text: string,
        ids: readonly DraftAttachmentId[],
        mode: InputSubmitMode,
        signal: AbortSignal,
      ]
    ): Promise<SubmitOutcome> => options.sink?.(args[0], args[1]) ?? { kind: "success" },
  );
  const shell = new SessionInputShell({
    actx: new Context(),
    inputTriggers: () => stubTriggers(options.triggers),
    ...(options.cwd === undefined ? {} : { cwd: () => options.cwd }),
    defaultSink: (text, ids, mode, signal) => sink(text, ids, mode, signal),
    commandAttachments: {
      serialize: async () => [],
      release: () => {},
      unsupportedNotice: (token) => `unsupported:${token}`,
    },
  });
  created.push(shell);
  return { shell, sink };
}

/** 草稿偏移区间上的令牌 span（草稿修订号取当前值）。 */
function span(shell: SessionInputShell, start: number, end: number): TokenSpan {
  return { start, end, draftRev: shell.snapshot.draftRev };
}

afterEach(() => {
  for (const shell of created.splice(0)) shell.dispose();
});

describe("SessionInputShell: 工作区相对化（deps.cwd 注入）", () => {
  it("把工作区内的绝对路径相对化，工作区外保持原样", () => {
    const { shell } = bench({ cwd: "/w/proj" });
    expect(shell.clipboardUri("/w/proj/src/a.ts")).toBe("src/a.ts");
    expect(shell.clipboardUri("/tmp/other/a.ts")).toBe("/tmp/other/a.ts");
  });

  it("没有注入 cwd 时绝对路径原样保留", () => {
    const { shell } = bench();
    expect(shell.clipboardUri("/w/proj/src/a.ts")).toBe("/w/proj/src/a.ts");
  });
});

describe("SessionInputShell: 引用插入落纯文本", () => {
  it("insertReference 把裸 URI 写进草稿并补一个尾随空格，不产生引用出现项", () => {
    const { shell } = bench();
    shell.setDraft("@src/");
    expect(shell.insertReference(FILE_INSERT, span(shell, 0, 5))).toBe(true);

    expect(shell.snapshot.draft).toBe("file:src/a.ts ");
    expect(shell.snapshot.occurrences).toEqual([]);
  });

  it("草稿在插入点后已有空格时不重复追加，且保留后续文本", () => {
    const { shell } = bench();
    shell.setDraft("@src/ 继续");
    expect(shell.insertReference(FILE_INSERT, span(shell, 0, 5))).toBe(true);

    expect(shell.snapshot.draft).toBe("file:src/a.ts 继续");
  });

  it("空草稿的插入落在末尾", () => {
    const { shell } = bench();
    expect(shell.insertReference(FILE_INSERT, span(shell, 0, 0))).toBe(true);

    expect(shell.snapshot.draft).toBe("file:src/a.ts ");
  });

  it("草稿修订号不匹配的插入被拒绝", () => {
    const { shell } = bench();
    shell.setDraft("@src/");
    const stale = { ...span(shell, 0, 5), draftRev: shell.snapshot.draftRev - 1 };

    expect(shell.insertReference(FILE_INSERT, stale)).toBe(false);
    expect(shell.snapshot.draft).toBe("@src/");
  });

  it("草稿已在指令裁定中（冻结）时插入被拒绝", async () => {
    let settle = (): void => {};
    const { shell } = bench({
      triggers: {
        adjudicate: () =>
          new Promise((resolve) => {
            settle = () => {
              resolve(undefined);
            };
          }),
      },
    });
    shell.setDraft("/goal 上线");
    shell.submit("queue");
    expect(shell.snapshot.phase).toBe("adjudicating");

    expect(shell.insertReference(FILE_INSERT, span(shell, 12, 12))).toBe(false);
    settle();
    await Promise.resolve();
  });
});

describe("SessionInputShell: 草稿写入与还原", () => {
  it("setDraft 剥离草稿文本里的对象占位符", () => {
    const { shell } = bench();
    shell.setDraft("看这个\uFFFC再继续");
    expect(shell.snapshot.draft).toBe("看这个再继续");
  });

  it("restoreDraft 只写回纯文本，不重建引用出现项", () => {
    const { shell } = bench();
    shell.actions.restoreDraft("看 file:src/a.ts");

    expect(shell.snapshot.draft).toBe("看 file:src/a.ts");
    expect(shell.snapshot.occurrences).toEqual([]);
  });

  it("consumeToken 的 token 形状要求草稿整体等于该 token", () => {
    const { shell } = bench();
    shell.setDraft("/goal");

    expect(shell.consumeToken({ kind: "bare-token", token: "/goal" })).toBe(true);
    expect(shell.snapshot.draft).toBe("");

    shell.setDraft("/goal 现在");
    expect(shell.consumeToken({ kind: "bare-token", token: "/goal" })).toBe(false);
    expect(shell.snapshot.draft).toBe("/goal 现在");
  });
});

describe("SessionInputShell: 提交路径", () => {
  it("提交把去掉首尾空白的草稿交给 sink，并清空草稿", () => {
    const { shell, sink } = bench();
    shell.setDraft("  hello  ");
    shell.submit("steer");

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toBe("hello");
    expect(sink.mock.calls[0]?.[1]).toEqual([]);
    expect(sink.mock.calls[0]?.[2]).toBe("steer");
    expect(shell.snapshot.draft).toBe("");
  });

  it("草稿里的引用以纯文本形态直接交给 sink，不经引用序列化器", () => {
    const serializeReference = vi.fn(async () => "@[a.ts](file:src/a.ts)");
    const { shell, sink } = bench({ triggers: { serializeReference } });
    shell.setDraft("看这个");
    shell.insertReference(FILE_INSERT, span(shell, 3, 3));
    expect(shell.snapshot.draft).toBe("看这个file:src/a.ts ");
    shell.submit("queue");

    expect(sink.mock.calls[0]?.[0]).toBe("看这个file:src/a.ts");
    expect(serializeReference).not.toHaveBeenCalled();
  });

  it("只有附件没有文本时也走 sink，并带上附件 id", async () => {
    const { shell, sink } = bench();
    shell.addAttachments(["a1" as DraftAttachmentId]);
    shell.submit("queue");
    await Promise.resolve();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toBe("");
    expect(sink.mock.calls[0]?.[1]).toEqual(["a1"]);
  });

  it("空白草稿且无附件的提交不触碰 sink", () => {
    const { shell, sink } = bench();
    shell.setDraft("   ");
    shell.submit("queue");

    expect(sink).not.toHaveBeenCalled();
  });

  it("sink 失败时草稿与附件回到编辑区并给出错误提示", async () => {
    const { shell } = bench({ sink: () => ({ kind: "error", text: "网络错误" }) });
    shell.addAttachments(["a1" as DraftAttachmentId]);
    shell.setDraft("看这个");
    shell.submit("queue");

    await vi.waitFor(() => {
      expect(shell.snapshot.draft).toBe("看这个");
    });
    expect(shell.snapshot.attachmentIds).toEqual(["a1"]);
    expect(shell.notices.getSnapshot()).toMatchObject({ level: "error", text: "网络错误" });
  });
});

describe("SessionInputShell: 通知与释放", () => {
  it("notify 递增 seq，dispose 返回残余附件 id 且只释放一次", () => {
    const { shell } = bench();
    shell.notify("info", "一");
    shell.notify("error", "二");
    expect(shell.notices.getSnapshot()).toMatchObject({ level: "error", text: "二", seq: 2 });

    shell.addAttachments(["a1" as DraftAttachmentId]);
    expect(shell.dispose()).toEqual(["a1"]);
    expect(shell.dispose()).toEqual([]);
  });
});
