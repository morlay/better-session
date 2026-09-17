export interface QueueRowText {
  readonly text: string | null;
  readonly preview: string;
}

export function queueTextOf(row: QueueRowText): string {
  return row.text ?? row.preview;
}
