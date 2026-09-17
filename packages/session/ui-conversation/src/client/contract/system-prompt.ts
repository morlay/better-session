import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { isSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { SystemPromptNode } from "./request-inspection.ts";

interface PositionedSystem {
  readonly position: number;
  readonly node: SystemPromptNode;
}

export interface SystemPromptState {
  readonly firstSeq: number;

  readonly uncertain: boolean;

  readonly nodes: readonly PositionedSystem[];

  readonly replacements: ReadonlyMap<number, number>;

  readonly effective: SystemPromptNode | undefined;

  readonly introduced: SystemPromptNode | undefined;
}

export type SystemPromptInspector = (
  previous: SystemPromptState | undefined,
  event: SessionEvent,
) => SystemPromptState;

export function inspectSystemPrompt(
  previous: SystemPromptState | undefined,
  event: SessionEvent,
): SystemPromptState {
  const op = isSurfaceEvent(event) ? event.surfaceOp : undefined;
  const firstSeq = previous?.firstSeq ?? event.seq;
  let nodes = previous?.nodes ?? [];
  let replacements = previous?.replacements ?? new Map<number, number>();
  const unknownEndpoint = (seq: number): boolean => seq < firstSeq && !replacements.has(seq);
  const uncertain =
    previous?.uncertain === true ||
    (op !== undefined &&
      op !== "append" &&
      (unknownEndpoint(op.startSeq) || unknownEndpoint(op.endSeq)));
  if (uncertain) {
    return {
      firstSeq,
      uncertain,
      nodes: [],
      replacements: new Map(),
      effective: undefined,
      introduced: undefined,
    };
  }
  let position: number = event.seq;
  if (op !== undefined && op !== "append") {
    position = replacements.get(op.startSeq) ?? op.startSeq;
    const end = replacements.get(op.endSeq) ?? op.endSeq;
    nodes = nodes.filter((item) => item.position < position || item.position > end);
    const retained = new Map(
      [...replacements].filter(([, value]) => value < position || value > end),
    );
    retained.set(event.seq, position);
    replacements = retained;
  }
  const introduced: SystemPromptNode | undefined =
    event.type === "system/message"
      ? {
          seq: event.seq,
          time: event.time,
          turn: event.data.turn,
          step: event.data.step,
          text: event.data.message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(""),
          update: op === "append" && previous?.nodes.some((item) => item.node.text !== "") === true,
        }
      : undefined;
  if (introduced !== undefined) {
    nodes = [...nodes, { position, node: introduced }].sort((a, b) => a.position - b.position);
  }
  const surviving = nodes.findLast((item) => item.node.text !== "")?.node;
  const effective =
    surviving === previous?.nodes.findLast((item) => item.node.text !== "")?.node
      ? previous?.effective
      : introduced !== undefined && introduced === surviving
        ? introduced
        : {
            seq: event.seq,
            time: event.time,
            turn: surviving?.turn ?? 0,
            step: surviving?.step ?? 0,
            text: surviving?.text ?? "",
            update: false,
          };
  return { firstSeq, uncertain, nodes, replacements, effective, introduced };
}
