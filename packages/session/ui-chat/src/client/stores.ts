import { defineStore, type EngineStoreHandle } from "@deepseek-ai/dsh-client-store";
import type { ChatStoreState, TurnProcessViewEntry } from "./contract/store.ts";

type ChatActions = {
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    answerStep: number,
    open: boolean,
  ) => void;
};

export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find((entry) => entry.turn === turn);
}

export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    init: (): ChatStoreState => ({ turnProcesses: [] }),
    actions: {
      setTurnProcessOpen: (draft, turn, answerStep, open) => {
        const index = draft.turnProcesses.findIndex((entry) => entry.turn === turn);
        if (!open) {
          if (index >= 0) draft.turnProcesses.splice(index, 1);
          return;
        }
        const next = { turn, answerStep } satisfies TurnProcessViewEntry;
        if (index < 0) draft.turnProcesses.push(next);
        else draft.turnProcesses[index] = next;
      },
    },
  });
}
