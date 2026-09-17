import type { Context } from "@deepseek-ai/cordis";
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  TurnMaxTokensNode,
} from "@morlay/dsh-client-ui-conversation/client";
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from "./common.ts";

declare module "../contract/chat-nodes.ts" {
  interface ChatNodeDataMap {
    "turn-max-tokens": TurnMaxTokensNode;
  }
}

interface TurnMaxTokensState {
  readonly turn: number;
  readonly seq: number;
  readonly time: number;
}

function lastStep(context: ConversationNodeContext<TurnMaxTokensState>): number {
  const location = context.start?.location ?? context.matches[0]?.location;
  if (location?.kind !== "turn" && location?.kind !== "step") return 0;
  return location.turn.steps.at(-1)?.step ?? 0;
}

function noticeAnchor(context: ConversationNodeContext<TurnMaxTokensState>, seq: number): number {
  const location = context.start?.location ?? context.matches[0]?.location;
  if (location?.kind !== "turn" && location?.kind !== "step") return seq;
  const closing = location.turn.data.get("turn-tail")?.closing;
  return closing === null || closing === undefined
    ? seq
    : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice;
}

function stateFrom(match: ConversationMatch): TurnMaxTokensState | undefined {
  if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "max-tokens")
    return undefined;
  return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time };
}

export const turnMaxTokensDefinition: ConversationNodeDefinition<TurnMaxTokensState> = {
  kind: "turn-max-tokens",
  target: "chat",
  match: (event) => {
    if (event.type === "turn/end" && event.data.reason.kind === "max-tokens") {
      return { id: String(event.data.turn), role: "start" };
    }
    return null;
  },
  start: (_context, match) => {
    const state = stateFrom(match);
    if (state === undefined)
      throw new Error("turn-max-tokens start requires a max-tokens turn/end");
    return state;
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    const state = context.state;
    if (state === undefined) return null;
    const node: TurnMaxTokensNode = {
      kind: "turn-max-tokens",
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step: lastStep(context),
    };
    return chatNode(context, "turn-max-tokens", noticeAnchor(context, state.seq), node);
  },
};

export function registerTurnMaxTokensConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnMaxTokensDefinition);
}
