import type { ViewTab } from "./contract/views.ts";

const DEFAULT_VIEW_ID = "chat";

export function resolveActiveView(
  tabs: readonly ViewTab[],
  selectedId: string | null,
): ViewTab | undefined {
  const selected = selectedId === null ? undefined : tabs.find((view) => view.id === selectedId);
  return selected ?? tabs.find((view) => view.id === DEFAULT_VIEW_ID);
}
