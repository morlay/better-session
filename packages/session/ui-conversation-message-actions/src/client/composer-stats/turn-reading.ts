// 窗口折叠（无 `sessionStats` 投影时的兜底）读一条 assistant 步的时序 / 用量。
// 从上游 ui-chat 的 `contract/turn-metrics.ts` 取出统计行真正用到的那一半，
// 只服务 composer 统计行。
import type { AssistantMessageNode } from "@deepseek-ai/dsh-client-ui-chat/client";

export interface StepReading {
  ttftMs: number | null;

  decodeMs: number | null;

  outputTokens: number | null;
}

interface UsageLike {
  outputTokens?: number;
}

function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const value = (usage as UsageLike).outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function assistantStepReading(node: AssistantMessageNode): StepReading {
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
