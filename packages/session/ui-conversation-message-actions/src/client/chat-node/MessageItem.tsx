// MessageItem: the user / admitted-steering chat node renderer.
// 官方 `@deepseek-ai/dsh-client-ui-chat` 内置全部 chat-node 渲染器；本项目仅**替换**
// `user`/`steering` 两个 key（keyed slot reuse 即替换），在消息动作行上提供
// edit / retry（上游无此能力）。其余 key 由官方内置渲染器处理。

import {
  markdownLabels,
  ReferenceMarkdown,
  styling,
  type ReferenceActions,
} from "@morlay/dsh-client-ui-primitives/client";
import { memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { UserMessageNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import { JsonBlock } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatNodeViewProps, ChatViewSlotProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { RenderMessageImages } from "@morlay/dsh-client-ui-conversation/client";
import { MessageIconActions } from "./MessageIconActions.tsx";
import { styles } from "./MessageItem.styles.ts";
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
  // 多块消息按空行拼回 raw markdown（新式提交就是单块原文）。
  return { text: texts.join("\n\n"), images, rest };
}

function UserStyleBubble({
  content,
  renderMessageImages,
  actions,
  references,
  t,
}: {
  content: readonly unknown[];
  renderMessageImages: RenderMessageImages;

  actions?: (text: string) => ReactNode;
  // 引用 chip 的点击目标（owner props；缺省时 chip 照常渲染但点击无效果）。
  references?: ReferenceActions | undefined;
  t: ChatViewSlotProps["t"];
}): ReactNode {
  const { text, images, rest } = contentParts(content);
  const truncated = (total: number): string => t("json.truncated", { total });
  // labels 按 locale revision 稳定（官方 MarkdownText 在它上面 memo 渲染缓存）。
  const labels = useMemo(() => markdownLabels(t), [t]);
  const showBubble = text !== "" || rest.length > 0;
  return (
    <div {...styling.props(styles.userRow)} data-time-hover-root>
      <div {...styling.props(styles.userStack)}>
        {renderMessageImages({ images, align: "end" })}
        {showBubble && (
          <div {...styling.props(styles.bubble)}>
            <ReferenceMarkdown text={text} labels={labels} actions={references} />
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
  openFile,
  openSkill,
  recall,
  retry,
}: ChatNodeViewProps<"user" | "steering"> & {
  // keyed 渲染器由 owner props 展开调用：引用 chip 的点击目标从这里来。
  openFile: (path: string) => void;
  openSkill: (name: string) => void;
} & InjectFace<SessionEditorFace>) {
  const data = node.data;
  const [confirmingRecall, setConfirmingRecall] = useState<EditableMessageBlock | null>(null);
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
  // 编辑（撤回）只要求存在可编辑文本块：轮外消息（location 无 turn/step
  // 归属）同样可撤回——服务端按消息自身位置截断，不依赖轮次边界。
  const onEdit =
    textBlock === undefined
      ? undefined
      : () => {
          setConfirmingRecall({
            key: `${node.anchorSeq}:${String(textBlockIndex)}`,
            ...(turn === undefined ? {} : { turn }),
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
      {confirmingRecall !== null && (
        <Modal
          open
          onClose={() => setConfirmingRecall(null)}
          title="编辑消息"
          closeLabel="关闭"
          description="将撤回该消息及其之后的对话内容到输入框，请修改后重新发送。"
          footer={
            <div {...styling.props(styles.confirmActions)}>
              <Button variant="outline" onClick={() => setConfirmingRecall(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const target = confirmingRecall;
                  setConfirmingRecall(null);
                  void recall(target);
                }}
              >
                撤回并编辑
              </Button>
            </div>
          }
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
            <div {...styling.props(styles.confirmActions)}>
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
        references={{ openFile, openSkill }}
        t={t}
        actions={(text) => (
          <MessageIconActions
            text={text}
            time={data.time}
            clock="start"
            t={t}
            onEdit={onEdit}
            onRetry={onRetry}
          />
        )}
      />
    </>
  );
});
