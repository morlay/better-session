import type { ChatNode } from "./chat-nodes.ts";

export interface TurnProcessSpec {
  readonly turn: number;

  readonly controlAnchorSeq: number;
  readonly processStartSeq: number;
  readonly answerAnchorSeq: number | null;
  readonly answerStep: number | null;
  readonly inlineReasoning: boolean;

  readonly messageCount: number;

  readonly toolCallCount: number;

  readonly subagentCount: number;
}

const TURN_PROCESS_INDEPENDENT_KIND_LIST = [
  "system-prompt",
  "user",
  "steering",
  "turn-process",
  "turn-error",
  "turn-max-tokens",
  "turn-tail",
] as const satisfies readonly ChatNode["kind"][];

export const TURN_PROCESS_INDEPENDENT_KINDS: ReadonlySet<string> = new Set(
  TURN_PROCESS_INDEPENDENT_KIND_LIST,
);

export function sameTurnProcessSpec(left: TurnProcessSpec, right: TurnProcessSpec): boolean {
  return (
    left.turn === right.turn &&
    left.controlAnchorSeq === right.controlAnchorSeq &&
    left.processStartSeq === right.processStartSeq &&
    left.answerAnchorSeq === right.answerAnchorSeq &&
    left.answerStep === right.answerStep &&
    left.inlineReasoning === right.inlineReasoning &&
    left.messageCount === right.messageCount &&
    left.toolCallCount === right.toolCallCount &&
    left.subagentCount === right.subagentCount
  );
}

export function isSubagentDelegationTool(name: string): boolean {
  return name === "subagent" || name.startsWith("subagent_");
}
