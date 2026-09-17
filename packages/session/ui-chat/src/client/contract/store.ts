export type ToolCallId = string;

export interface TurnProcessViewEntry {
  readonly turn: number;
  readonly answerStep: number;
}

export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[];
}
