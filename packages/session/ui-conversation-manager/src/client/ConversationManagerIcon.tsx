import { IconArchiveOutline20 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

/** nav 图标只画字形：尺寸由 nav 行给，选中态由 nav 行的按钮承担。 */
export type ConversationManagerIconProps = PropsRuntime<"sidebar.panellist">;

export function ConversationManagerIcon({ size }: ConversationManagerIconProps) {
  return <IconArchiveOutline20 size={size} />;
}
