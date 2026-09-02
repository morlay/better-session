// MessageItem: the user / admitted-steering chat node renderer.
// 新版 `dsh-client-ui-chat` 已内置全部 chat-node 渲染器；本项目仅**替换**
// `user`/`steering` 两个 key（keyed slot reuse 即替换），在消息动作行上提供
// edit / retry（新版无此能力）。其余 key 由新版内置渲染器处理。

import { memo, useState } from "react";
import type { ReactNode } from "react";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { UserMessageNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import { JsonBlock, MessageText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatNodeViewProps, ChatViewSlotProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { RenderMessageImages } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { MessageIconActions } from "./MessageIconActions.tsx";
import { MessageEditDialog } from "./MessageEditDialog.tsx";
import css from "./MessageItem.module.css";
import type { EditableMessageBlock } from "../../shared.ts";
import type { SessionEditorFace } from "../controller.ts";

type UserImage = Extract<UserMessageNode["content"][number], { type: "image" }>;

function contentParts(content: readonly unknown[]): {
  text: string;
  images: { attachment: UserImage["attachment"] }[];
  rest: unknown[];
} {
  const texts: string[] = [];
  const images: { attachment: UserImage["attachment"] }[] = [];
  const rest: unknown[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown };
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "image" && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment });
    } else rest.push(block);
  }
  return { text: texts.join(""), images, rest };
}

function projectUserText(text: string): ReactNode {
  const re = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0);
    const label = m[2] ?? "";
    if (tokenStart > cursor)
      parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />);
    parts.push(
      <span
        key={tokenStart}
        className={css.refChip}
        data-ref-chip={label.startsWith("@") ? "subagent" : "skill"}
      >
        {label}
      </span>,
    );
    cursor = tokenStart + label.length;
  }
  if (parts.length === 0) return <MessageText text={text} />;
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />);
  return <>{parts}</>;
}

function UserStyleBubble({
  content,
  renderMessageImages,
  actions,
  t,
}: {
  content: readonly unknown[];
  renderMessageImages: RenderMessageImages;

  actions?: (text: string) => ReactNode;
  t: ChatViewSlotProps["t"];
}): ReactNode {
  const { text, images, rest } = contentParts(content);
  const truncated = (total: number): string => t("json.truncated", { total });
  const showBubble = text !== "" || rest.length > 0;
  return (
    <div className={css.userRow} data-time-hover-root>
      <div className={css.userStack}>
        {renderMessageImages({ images, align: "end" })}
        {showBubble && (
          <div className={css.bubble}>
            {projectUserText(text)}
            {rest.map((block, i) => (
              <JsonBlock
                key={i}
                label={t("message.extraBlock")}
                payload={block}
                truncatedLabel={truncated}
              />
            ))}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  );
}

export const UserMessageNodeView = memo(function UserMessageNodeView({
  node,
  renderMessageImages,
  t,
  edit,
  retry,
}: ChatNodeViewProps<"user" | "steering"> & InjectFace<SessionEditorFace>) {
  const data = node.data;
  const [editing, setEditing] = useState<EditableMessageBlock | null>(null);
  const [confirmingRetry, setConfirmingRetry] = useState(false);
  const turnLocation =
    node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : undefined;
  const turn = turnLocation?.turn;
  // 重试只对已闭合轮次开放（未闭合/无闭合边界的轮次服务端无法重放）。
  const retryable = turnLocation?.status === "closed";
  // 编辑目标：第一个文本块（与 Timeline 编辑面的 blockIndex 对齐）。
  const textBlockIndex = data.content.findIndex(
    (block) => (block as { type?: string }).type === "text",
  );
  const textBlock =
    textBlockIndex === -1 ? undefined : (data.content[textBlockIndex] as { text?: string });
  const onEdit =
    textBlock === undefined || turn === undefined
      ? undefined
      : () => {
          setEditing({
            key: `${node.anchorSeq}:${String(textBlockIndex)}`,
            turn,
            eventSeq: node.anchorSeq,
            blockIndex: textBlockIndex,
            kind: "user",
            text: textBlock.text ?? "",
            time: data.time,
          });
        };
  // 重试先弹确认（就地编辑会抛弃该回合及其后的内容）。
  const onRetry =
    retryable && turn !== undefined
      ? () => {
          setConfirmingRetry(true);
        }
      : undefined;
  return (
    <>
      {editing !== null && (
        <MessageEditDialog
          block={editing}
          onSave={(text) => edit(editing, text, "truncate")}
          onClose={() => setEditing(null)}
        />
      )}
      {confirmingRetry && turn !== undefined && (
        <Modal
          open
          onClose={() => setConfirmingRetry(false)}
          title="重试回合"
          closeLabel="关闭"
          description={`将重新生成第 ${turn} 轮的回复，并抛弃该回合之后的内容。`}
          footer={
            <div className={css.confirmActions}>
              <Button variant="outline" onClick={() => setConfirmingRetry(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmingRetry(false);
                  void retry(turn, "truncate");
                }}
              >
                确认重试
              </Button>
            </div>
          }
        />
      )}
      <UserStyleBubble
        content={data.content}
        renderMessageImages={renderMessageImages}
        t={t}
        actions={(text) => (
          <MessageIconActions
            text={text}
            time={data.time}
            clock="start"
            className={css.actions}
            t={t}
            onEdit={onEdit}
            onRetry={onRetry}
          />
        )}
      />
    </>
  );
});
