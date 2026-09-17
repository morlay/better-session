import type { ContextPressureProjection } from "@deepseek-ai/dsh-token-meter/client";

export interface ContextOccupancy {
  percent: number;
  usedTokens: number;
  contextWindow: number;
}

export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null;
  return {
    percent: Math.min(100, Math.round((usedTokens / pressure.contextWindow) * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  };
}
