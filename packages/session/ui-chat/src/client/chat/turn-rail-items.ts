import type {} from "@deepseek-ai/dsh-session-turn-outline/client";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";
import type { TurnNavigationItem } from "../contract/snapshot.ts";

export interface TurnRailItem {
  readonly turn: number;

  readonly prompt: string;

  readonly response: string;

  readonly anchor:
    | { readonly kind: "loaded"; readonly key: string }
    | { readonly kind: "unloaded"; readonly seq: SessionSeq };
}

const EMPTY_ITEMS: readonly TurnRailItem[] = [];

function outlineEntry(
  value: unknown,
): { turn: number; seq: SessionSeq; prompt: string; response: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as { turn?: unknown; seq?: unknown; prompt?: unknown; response?: unknown };
  if (typeof entry.turn !== "number" || !Number.isSafeInteger(entry.turn) || entry.turn < 0)
    return undefined;
  if (
    typeof entry.seq !== "number" ||
    !Number.isSafeInteger(entry.seq) ||
    entry.seq < 0 ||
    Object.is(entry.seq, -0)
  )
    return undefined;
  return {
    turn: entry.turn,
    seq: SessionSeq(entry.seq),
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    response: typeof entry.response === "string" ? entry.response : "",
  };
}

function outlineEntries(outline: unknown): readonly unknown[] {
  return Array.isArray(outline) ? outline : EMPTY_ITEMS;
}

export function mergeTurnRailItems(
  loaded: readonly TurnNavigationItem[],
  outline: unknown,
): readonly TurnRailItem[] {
  const byTurn = new Map<number, TurnRailItem>();
  for (const raw of outlineEntries(outline)) {
    const entry = outlineEntry(raw);
    if (entry === undefined) continue;
    byTurn.set(entry.turn, {
      turn: entry.turn,
      prompt: entry.prompt,
      response: entry.response,
      anchor: { kind: "unloaded", seq: entry.seq },
    });
  }
  for (const item of loaded) {
    const preview = byTurn.get(item.turn);
    byTurn.set(item.turn, {
      turn: item.turn,
      prompt: item.prompt !== "" ? item.prompt : (preview?.prompt ?? ""),
      response: item.response !== "" ? item.response : (preview?.response ?? ""),
      anchor: { kind: "loaded", key: item.anchorKey },
    });
  }
  if (byTurn.size === 0) return EMPTY_ITEMS;
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
}
