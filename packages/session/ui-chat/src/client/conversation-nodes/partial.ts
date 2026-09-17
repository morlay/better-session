import type { StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { AssistantBlock, PartialAssistant } from "@morlay/dsh-client-ui-conversation/client";
import { emptyAssistantBlock, toAssistantBlock } from "./event-projection.ts";

export function isVisibleAssistantChunk(type: string): boolean {
  return (
    type === "block-start" ||
    type === "text-delta" ||
    type === "reasoning-delta" ||
    type === "tool-call-delta" ||
    type === "block-end"
  );
}

export class PartialAccumulator {
  private blocks: (AssistantBlock | undefined)[] = [];
  private changed = true;
  private snapshot: PartialAssistant;

  constructor(
    readonly turn: number,
    readonly step: number,
    initialBlocks: readonly AssistantBlock[] = [],
  ) {
    this.blocks = [...initialBlocks];
    this.snapshot = { turn, step, blocks: initialBlocks };
  }

  push(chunk: StreamChunk): boolean {
    switch (chunk.type) {
      case "block-start": {
        this.blocks[chunk.index] = emptyAssistantBlock(chunk.blockType);
        this.changed = true;
        return true;
      }
      case "text-delta": {
        const prev = this.blocks[chunk.index];
        this.blocks[chunk.index] = {
          kind: "text",
          text: (prev?.kind === "text" ? prev.text : "") + chunk.text,
        };
        this.changed = true;
        return true;
      }
      case "reasoning-delta": {
        const prev = this.blocks[chunk.index];
        this.blocks[chunk.index] = {
          kind: "reasoning",
          text: (prev?.kind === "reasoning" ? prev.text : "") + chunk.text,
        };
        this.changed = true;
        return true;
      }
      case "tool-call-delta": {
        const prev = this.blocks[chunk.index];
        const base =
          prev?.kind === "tool-call"
            ? prev
            : { kind: "tool-call" as const, callId: "", name: "", argsRaw: "" };
        this.blocks[chunk.index] = {
          kind: "tool-call",
          callId: base.callId || String(chunk.id),
          name: chunk.name ?? base.name,
          argsRaw: base.argsRaw + chunk.argumentsDelta,
        };
        this.changed = true;
        return true;
      }
      case "block-end": {
        this.blocks[chunk.index] = toAssistantBlock(chunk.block);
        this.changed = true;
        return true;
      }
      default:
        return false;
    }
  }

  toPartial(): PartialAssistant {
    if (this.changed) {
      this.snapshot = {
        turn: this.turn,
        step: this.step,
        blocks: this.blocks.filter((b): b is AssistantBlock => b !== undefined),
      };
      this.changed = false;
    }
    return this.snapshot;
  }
}
