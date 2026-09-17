import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  DEFAULT_TRANSCRIPT_VIEW_MODE,
  TRANSCRIPT_VIEW_FIELD,
  type ChatSettings,
  type TranscriptViewMode,
} from "../chat-settings.ts";

export class TranscriptViewPolicy {
  readonly mode: SnapshotStore<TranscriptViewMode> = createSnapshotStore(
    DEFAULT_TRANSCRIPT_VIEW_MODE,
  );

  constructor(private readonly host: SettingsScope<ChatSettings>) {
    host.subscribe(() => {
      this.adopt();
    });
    this.adopt();
  }

  setMode(mode: TranscriptViewMode): void {
    if (this.mode.getSnapshot() === mode) return;
    this.mode.set(mode);
    void this.host.set(TRANSCRIPT_VIEW_FIELD, mode);
  }

  private adopt(): void {
    const section = this.host.getSnapshot().value;
    if (section === undefined || this.mode.getSnapshot() === section.transcriptView) return;
    this.mode.set(section.transcriptView);
  }
}
