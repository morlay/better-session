import type {} from "@morlay/dsh-client-ui-conversation/client";
import type { InputTriggerCrumb, PickAction } from "../types.ts";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { MenuState } from "../core/contract.ts";

export interface MenuViewInjected {
  menu: SnapshotStore<MenuState>;

  headers: SnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>;

  onPick: (source: string, index: number, action?: PickAction) => void;

  onHover: (source: string, index: number) => void;

  onCrumb: (source: string, index: number) => void;

  onDismiss: () => void;
}
