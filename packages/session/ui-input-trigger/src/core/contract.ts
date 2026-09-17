import type { TokenSpan } from "@morlay/dsh-client-ui-conversation/client";
import type {
  InputTriggerCandidate,
  TriggerChar,
  TriggerGuard,
  TriggerPosition,
} from "../types.ts";

export interface TriggerHit {
  readonly trigger: TriggerChar;

  readonly query: string;

  readonly quoted: boolean;

  readonly position: TriggerPosition;

  readonly span: TokenSpan;
}

export type DetectTrigger = (
  draft: string,
  caret: number,
  guard: TriggerGuard,
) => TriggerHit | null;

export interface MenuState {
  readonly open: boolean;
  readonly hit: TriggerHit | null;

  readonly generation: number;
  readonly groups: readonly {
    readonly source: string;

    readonly showGroupTitle?: boolean;
    readonly status: "pending" | "ready";
    readonly items: readonly InputTriggerCandidate[];
  }[];
  readonly highlight: { readonly source: string; readonly index: number } | null;
}

export type MenuEvent =
  | { readonly type: "hit"; readonly hit: TriggerHit | null }
  | {
      readonly type: "source-settled";
      readonly generation: number;
      readonly source: string;
      readonly items?: readonly InputTriggerCandidate[];
    }
  | { readonly type: "source-failed"; readonly generation: number; readonly source: string }
  | { readonly type: "move"; readonly dir: 1 | -1 }
  | { readonly type: "hover"; readonly source: string; readonly index: number }
  | { readonly type: "close" };

export type MenuReduce = (state: MenuState, ev: MenuEvent) => MenuState;

export type ExactMatch = (
  groups: MenuState["groups"],
  source: string,
  name: string,
) => InputTriggerCandidate | null;
