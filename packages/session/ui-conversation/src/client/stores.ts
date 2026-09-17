import { defineStore, type EngineStoreHandle } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ConversationStoreState } from "./contract/views.ts";

const CONVERSATION_STORE_KEY = "dsh.conversation";

type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: string) => void;
  setView: (draft: ConversationStoreState, view: string) => void;
  openView: (draft: ConversationStoreState, view: string, focus: string) => void;
  completeViewRequest: (draft: ConversationStoreState) => void;
};

export function createConversationStore(): EngineStoreHandle<
  ConversationStoreState,
  ConversationActions
> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: "", view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: string) => {
        d.draft = text;
      },
      setView: (d, view: string) => {
        d.view = view;
      },
      openView: (d, view: string, focus: string) => {
        d.view = view;
        d.viewRequest = { view, focus };
      },
      completeViewRequest: (d) => {
        d.viewRequest = null;
      },
    },
  });
}

export function readConversationViewPreference(sessionId: SessionId): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`);
    if (raw === null) return null;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || !("view" in stored)) return null;
    return typeof stored.view === "string" ? stored.view : null;
  } catch {
    return null;
  }
}
