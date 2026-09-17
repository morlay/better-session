export type ContextRole = "inject" | "recall";

export interface ContextProducerView {
  role: ContextRole;

  label: string | null;
}

export type KnownContextForm =
  | "instructions"
  | "catalog"
  | "snapshot"
  | "notice"
  | "relay"
  | "recall";
