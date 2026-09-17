import type {
  AssistantMessageNode,
  ConversationNode,
} from "@morlay/dsh-client-ui-conversation/client";

export interface TurnMetrics {
  ttftMs?: number;

  tokensPerSecond?: number;
}

export interface StepReading {
  ttftMs: number | null;

  decodeMs: number | null;

  outputTokens: number | null;
}

interface UsageLike {
  outputTokens?: number;
}

type AssistantNode = AssistantMessageNode;

function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const value = (usage as UsageLike).outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function assistantStepReading(node: AssistantNode): StepReading {
  const timing = node.timing;
  const ttftMs =
    timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
      ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
      : null;
  const decodeMs =
    timing !== undefined && timing.firstTokenTime !== null
      ? Math.max(0, timing.completedTime - timing.firstTokenTime)
      : null;
  return { ttftMs, decodeMs, outputTokens: usageOutputTokens(node.usage) };
}

interface TurnFold {
  firstStep: number;
  firstStepTtftMs: number | null;
  decodeMs: number;
  outputTokens: number;
  sampled: boolean;
}

export function deriveTurnMetrics(nodes: readonly ConversationNode[]): Map<number, TurnMetrics> {
  const folds = new Map<number, TurnFold>();
  for (const node of nodes) {
    if (node.kind !== "assistant") continue;
    const reading = assistantStepReading(node);
    let fold = folds.get(node.turn);
    if (fold === undefined) {
      fold = {
        firstStep: node.step,
        firstStepTtftMs: reading.ttftMs,
        decodeMs: 0,
        outputTokens: 0,
        sampled: false,
      };
      folds.set(node.turn, fold);
    } else if (node.step < fold.firstStep) {
      fold.firstStep = node.step;
      fold.firstStepTtftMs = reading.ttftMs;
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      fold.decodeMs += reading.decodeMs;
      fold.outputTokens += reading.outputTokens;
      fold.sampled = true;
    }
  }
  const metrics = new Map<number, TurnMetrics>();
  for (const [turn, fold] of folds) {
    const entry: TurnMetrics = {};
    if (fold.firstStepTtftMs !== null) entry.ttftMs = fold.firstStepTtftMs;
    if (fold.sampled && fold.decodeMs > 0)
      entry.tokensPerSecond = fold.outputTokens / (fold.decodeMs / 1000);
    if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined) metrics.set(turn, entry);
  }
  return metrics;
}
