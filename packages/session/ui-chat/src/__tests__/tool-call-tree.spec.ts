// 工具调用树：ptc 派发事件把子调用挂到所属调用之下，结算事件把同一子调用换成结果，
// 成环的边与越界的深度一律拒绝。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import type {
  ConversationNode,
  RunningToolCall,
  ToolResultNode,
} from "@morlay/dsh-client-ui-conversation/client";
import { ToolCallTree } from "../client/model/tool-call-tree.ts";

function result(callId: string, subCalls: readonly RunningToolCall[] = []): ToolResultNode {
  return {
    kind: "tool-result",
    seq: 1,
    time: 1,
    callId,
    call: { name: "task", argsRaw: "{}" },
    callTime: 1,
    content: [],
    isError: false,
    subCalls,
  };
}

function running(callId: string, time = 1): RunningToolCall {
  return {
    callId,
    parentCallId: "root",
    name: "bash",
    argsRaw: "{}",
    turn: 1,
    step: 1,
    time,
    subCalls: [],
  };
}

function dispatchStart(
  seq: number,
  parentCallId: string,
  subCallId: string,
  args: unknown = { cmd: "ls" },
  time = seq,
): SessionEvent {
  return {
    type: "tool/ptc-dispatch-start",
    seq,
    time,
    data: { rootCallId: "root", parentCallId, subCallId, name: "bash", arguments: args },
  } as unknown as SessionEvent;
}

function dispatch(
  seq: number,
  parentCallId: string,
  subCallId: string,
  args: unknown = { cmd: "ls" },
  time = seq,
): SessionEvent {
  return {
    type: "tool/ptc-dispatch",
    seq,
    time,
    data: {
      rootCallId: "root",
      parentCallId,
      subCallId,
      name: "bash",
      arguments: args,
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
  } as unknown as SessionEvent;
}

function treeOf(...events: readonly SessionEvent[]): ToolCallTree {
  const tree = new ToolCallTree();
  for (const event of events) tree.apply(event);
  return tree;
}

function rootOf(nodes: readonly ConversationNode[]): ToolResultNode {
  return nodes[0] as ToolResultNode;
}

describe("ToolCallTree", () => {
  it("ignores events that are not ptc dispatches", () => {
    const tree = new ToolCallTree();
    const unrelated = {
      type: "user/message",
      seq: 1,
      time: 1,
      data: {},
    } as unknown as SessionEvent;
    expect(tree.apply(unrelated)).toBe(false);
  });

  it("hangs a dispatched child under the parent block", () => {
    const tree = treeOf(dispatchStart(2, "root", "child", { cmd: "ls -la" }, 7));
    const projected = tree.projectNodes([result("root")]);
    const child = rootOf(projected).subCalls[0] as RunningToolCall;
    expect(child.callId).toBe("child");
    expect(child.parentCallId).toBe("root");
    expect(child.name).toBe("bash");
    expect(child.argsRaw).toBe('{"cmd":"ls -la"}');
    expect(child.time).toBe(7);
    expect(child.subCalls).toEqual([]);
  });

  it("replaces a dispatched child with its settled result", () => {
    const tree = treeOf(
      dispatchStart(2, "root", "child", { cmd: "ls" }, 7),
      dispatch(3, "root", "child", { cmd: "ls" }, 9),
    );
    const projected = tree.projectNodes([result("root")]);
    const child = rootOf(projected).subCalls[0] as ToolResultNode;
    expect(child.kind).toBe("tool-result");
    expect(child.callId).toBe("child");
    expect(child.seq).toBe(3);
    expect(child.callTime).toBe(7);
    expect(child.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("keeps a settled child without a recorded start time", () => {
    const tree = treeOf(dispatch(3, "root", "child"));
    const projected = tree.projectNodes([result("root")]);
    const child = rootOf(projected).subCalls[0] as ToolResultNode;
    expect(child.kind).toBe("tool-result");
    expect(child.callTime).toBeNull();
  });

  it("nests grandchildren under their own parent", () => {
    const tree = treeOf(dispatchStart(2, "root", "child"), dispatchStart(3, "child", "grandchild"));
    const projected = tree.projectNodes([result("root")]);
    const child = rootOf(projected).subCalls[0] as RunningToolCall;
    expect(child.subCalls.map((block) => block.callId)).toEqual(["grandchild"]);
  });

  it("refuses an edge that would close a cycle", () => {
    const tree = treeOf(dispatchStart(2, "root", "child"), dispatchStart(3, "child", "root"));
    const projected = tree.projectNodes([result("root")]);
    const child = rootOf(projected).subCalls[0] as RunningToolCall;
    expect(child.subCalls).toEqual([]);
  });

  it("refuses a self edge", () => {
    const tree = treeOf(dispatchStart(2, "root", "root"));
    const projected = tree.projectNodes([result("root")]);
    expect(rootOf(projected).subCalls).toEqual([]);
  });

  it("bounds a pathological dispatch chain", () => {
    const tree = new ToolCallTree();
    tree.apply(dispatchStart(1, "root", "call-1"));
    for (let depth = 2; depth <= 300; depth += 1) {
      tree.apply(dispatchStart(depth, `call-${depth - 1}`, `call-${depth}`));
    }
    const projected = tree.projectNodes([result("root")]);
    let cursor: RunningToolCall | undefined = rootOf(projected).subCalls[0] as
      | RunningToolCall
      | undefined;
    let depth = 0;
    while (cursor !== undefined && cursor.subCalls.length > 0) {
      cursor = cursor.subCalls[0] as RunningToolCall;
      depth += 1;
    }
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(300);
  });

  it("projects running calls the same way", () => {
    const tree = treeOf(dispatchStart(2, "root", "child"));
    const projected = tree.projectRunningCalls([running("root")]);
    expect(projected[0]?.subCalls.map((block) => block.callId)).toEqual(["child"]);
  });

  it("forgets every edge after a reset", () => {
    const tree = treeOf(dispatchStart(2, "root", "child"));
    tree.reset();
    const projected = tree.projectNodes([result("root")]);
    expect(rootOf(projected).subCalls).toEqual([]);
  });

  it("leaves nodes of other kinds untouched", () => {
    const tree = treeOf(dispatchStart(2, "root", "child"));
    const user = { kind: "user", seq: 1, time: 1 } as unknown as ConversationNode;
    expect(tree.projectNodes([user])[0]).toBe(user);
  });
});
