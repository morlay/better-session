import z from "@deepseek-ai/schemastery";

export const CHAT_SETTINGS_NAMESPACE = "ui-chat";

export const TRANSCRIPT_VIEW_FIELD = "transcriptView";

export const TRANSCRIPT_VIEW_MODES = ["normal", "compact"] as const;

export type TranscriptViewMode = (typeof TRANSCRIPT_VIEW_MODES)[number];

export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = "compact";

export interface ChatSettings {
  transcriptView: TranscriptViewMode;
}

export const ChatSettingsSchema: z<ChatSettings> = z.object({
  [TRANSCRIPT_VIEW_FIELD]: z
    .union([...TRANSCRIPT_VIEW_MODES])
    .default(DEFAULT_TRANSCRIPT_VIEW_MODE),
});
