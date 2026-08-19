// MessageItem: simple chat nodes — user and consumed-steering bubbles
// (right-aligned, with clock + copy IconActions; branch lives only under
// assistant answers), pending steering (copy only), context injection,
// compaction marker, retry disclosure, and unknown-surface JSON rows.

import { memo, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  ModelRetryNode,
  TurnErrorNode,
  UserMessageNode,
} from "@deepseek-ai/dsh-client-runtime/client";
import { JsonBlock, MessageText, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  ChatNodeViewProps,
  ChatViewSlotProps,
  RenderMessageImages,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { CompactionItem } from "./CompactionItem.tsx";
import { ContextInjectionRow } from "./ContextInjectionRow.tsx";
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

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000));
}

interface RetryCountdown {
  deadline: number;
  seconds: number;
}

function ModelRetryItem({
  node,
  active,
  t,
}: {
  node: ModelRetryNode;
  active: boolean;
  t: ChatViewSlotProps["t"];
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq]);
  const scheduledSeconds = retrySeconds(node.delayMs);
  const maximum = node.mode === "normal" ? node.maxRetries : "∞";
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }));
  const remainingSeconds =
    countdown.deadline === deadline ? countdown.seconds : retrySeconds(deadline - Date.now());

  useEffect(() => {
    if (!active) return;
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now());
      setCountdown((current) =>
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next },
      );
      return next;
    };
    if (updateCountdown() === 1) return;
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer);
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [active, deadline]);

  const label = active
    ? t("message.retry.active")
    : node.retryState === "cancelled"
      ? t("message.retry.cancelled")
      : node.retryState === "started"
        ? t("message.retry.started")
        : t("message.retry.scheduled");
  const seconds = active ? remainingSeconds : scheduledSeconds;

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t("message.retry.status", { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t("message.retry.delay")}</span>
          {Math.round(node.delayMs)}ms
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t("message.retry.failure")}</span>
          {node.failure.message}
        </div>
      </div>
    </details>
  );
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: { node: TurnErrorNode; t: ChatViewSlotProps["t"] }) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t("message.turnError")}</span>
        <span className={css.turnErrorMessage}>{node.message}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  );
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: { t: ChatViewSlotProps["t"] }) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t("message.maxTokens")}</span>
        <span className={css.turnErrorMessage}>{t("message.maxTokens.hint")}</span>
      </div>
    </div>
  );
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only.
 * Plain-text `/name` / `@name` word-boundary tokens decorate (the sent text
 * IS the reference — the bubble uses the same plainest token
 * scan as the composer, minus the lexicon: sent tokens were validated at
 * compose time, so shape alone decorates).
 */
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

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content,
  renderMessageImages,
  actions,
  pending = false,
  t,
}: {
  content: readonly unknown[];
  renderMessageImages: RenderMessageImages;
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode;
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean;
  t: ChatViewSlotProps["t"];
}): ReactNode {
  const { text, images, rest } = contentParts(content);
  const truncated = (total: number): string => t("json.truncated", { total });
  const showBubble = text !== "" || rest.length > 0;
  return (
    <div className={css.userRow} data-pending-steering={pending || undefined} data-time-hover-root>
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

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({
  content,
  renderMessageImages,
  t,
}: {
  content: readonly unknown[];
  renderMessageImages: RenderMessageImages;
  t: ChatViewSlotProps["t"];
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={(text) => (
        <MessageIconActions text={text} clock="start" className={css.actions} t={t} />
      )}
    />
  );
}

/** User and admitted-steering keyed Chat renderer. */
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

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({
  node,
  t,
}: ChatNodeViewProps<"context">) {
  const data = node.data;
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  );
});

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({
  node,
  t,
}: ChatNodeViewProps<"compaction">) {
  return <CompactionItem node={node.data} t={t} />;
});

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({
  node,
  t,
}: ChatNodeViewProps<"model-retry">) {
  const data = node.data;
  return (
    <ModelRetryItem node={data.current} active={data.current.retryState === "scheduled"} t={t} />
  );
});

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({
  node,
  t,
}: ChatNodeViewProps<"turn-error">) {
  return <TurnErrorItem node={node.data} t={t} />;
});

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({
  t,
}: ChatNodeViewProps<"turn-max-tokens">) {
  return <TurnMaxTokensItem t={t} />;
});

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({
  node,
  t,
}: ChatNodeViewProps<"unknown">) {
  const data = node.data;
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t("message.unknownSurface", { type: data.type })}
        payload={data.data}
        truncatedLabel={(total) => t("json.truncated", { total })}
      />
    </div>
  );
});
