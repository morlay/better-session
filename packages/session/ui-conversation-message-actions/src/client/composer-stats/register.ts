import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@morlay/dsh-client-ui-conversation/client";
import { StatsPills } from "./StatsPills.tsx";

// 官方 ui-chat 的字典命名空间：文案沿用上游（`stats.*` / `message.turnUsage.*`）。
const NS = "chat";

// 覆盖注册：官方 ui-chat 在 `conversation.composer.dock` 注册 id `stats`（优先级 0），
// 我们以 priority -1 同 id 重新注册——最低优先级渲染，shadow 官方那一格。
// 覆盖是 shadow 不是删除：官方 stats 行仍在注册表里。
export function registerComposerStats(slots: Context["slots"]): () => void {
  return slots.register(
    { name: "conversation.composer.dock", id: "stats", order: 0, priority: -1, locale: NS },
    StatsPills,
  );
}
