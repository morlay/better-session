import z from "@deepseek-ai/schemastery";

export const CONVERSATION_SETTINGS_NAMESPACE = "ui-conversation";

export const BUSY_ENTER_FIELD = "busyEnter";

export const BUSY_ENTER_BEHAVIORS = ["queue", "steer"] as const;

export type BusyEnterBehavior = (typeof BUSY_ENTER_BEHAVIORS)[number];

export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = "queue";

export interface ConversationSettings {
  busyEnter: BusyEnterBehavior;
}

export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
});
