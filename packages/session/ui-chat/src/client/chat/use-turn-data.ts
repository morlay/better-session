import { useSyncExternalStore } from "react";
import type {
  ConversationLocationDataSource,
  ConversationLocationDataStore,
  ConversationTurnDataMap,
} from "@morlay/dsh-client-ui-conversation/client";

const EMPTY_SOURCE: ConversationLocationDataSource<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
};

export function useTurnDataValue<Key extends Extract<keyof ConversationTurnDataMap, string>>(
  data: ConversationLocationDataStore<ConversationTurnDataMap> | undefined,
  key: Key,
): Readonly<ConversationTurnDataMap[Key]> | undefined {
  const source = data?.source(key) ?? EMPTY_SOURCE;
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
