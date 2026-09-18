import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import {
  markdownLabels,
  ReferenceMarkdown,
  styling,
} from "@morlay/dsh-client-ui-primitives/client";
import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useId, useMemo, useState } from "react";
import type { FileAttachmentRef, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  FileTypeIcon,
  fileSizeText,
  IconEditOutline16,
  IconQueueOutline14,
  IconSendOutline14,
  IconTrashOutline16,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InboxState } from "@deepseek-ai/dsh-agent/types";
import type { QueueAction } from "@deepseek-ai/dsh-api-session-controller/types";
import type { MessageId } from "@deepseek-ai/dsh-llm/brand";
import { NS } from "../../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/locales.ts";
import { queueRowTextOf, queueTextOf } from "./queue-text.ts";
import { styles } from "./QueueDock.styles.ts";

const EMPTY_QUEUE = [] as const;

/** Queue operations injected by the session-scoped registration. */
export interface QueueDockInjected {
  updateQueue: (itemId: MessageId, action: QueueAction) => Promise<void>;
  notify: (level: "info" | "error", text: string) => void;
  /** Resolve one durable queued image into a session-scoped browser URL. */
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>;
}

/**
 * Durable references carried by one queued row. Queue frames are wire data
 * despite their typed face, so an image block without a reference is skipped
 * rather than trusted.
 * @param content - the row's wire content blocks.
 * @returns the row's durable image references in block order.
 */
function queueAttachments(
  content: InboxState["next-turn"][number]["content"],
): Array<
  | { readonly type: "image"; readonly attachment: ImageAttachmentRef }
  | { readonly type: "file"; readonly attachment: FileAttachmentRef }
> {
  const attachments: Array<
    | { readonly type: "image"; readonly attachment: ImageAttachmentRef }
    | { readonly type: "file"; readonly attachment: FileAttachmentRef }
  > = [];
  for (const block of content) {
    if (block.type === "image") {
      const { attachment } = block as { attachment?: ImageAttachmentRef };
      if (attachment !== undefined) attachments.push({ type: "image", attachment });
    }
    if (block.type === "file") {
      const { attachment } = block as { attachment?: FileAttachmentRef };
      if (attachment !== undefined) attachments.push({ type: "file", attachment });
    }
  }
  return attachments;
}

/** Compact file identity used beside queue thumbnails. */
function QueueFile({ attachment, label }: { attachment: FileAttachmentRef; label: string }) {
  return (
    <span {...styling.props(styles.file)} aria-label={label} title={attachment.name}>
      <span {...styling.props(styles.fileIcon)} aria-hidden>
        <FileTypeIcon path={attachment.name} size={16} />
      </span>
      <span {...styling.props(styles.fileName)}>{attachment.name}</span>
      <span {...styling.props(styles.fileSize)}>{fileSizeText(attachment.bytes)}</span>
    </span>
  );
}

/** One durable queued image as a fixed-size thumbnail; a load failure keeps the empty placeholder. */
function QueueThumb({
  attachment,
  loadImage,
  label,
}: {
  attachment: ImageAttachmentRef;
  loadImage: QueueDockInjected["loadImage"];
  label: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadImage(attachment).then(
      (resolved) => {
        if (alive) setUrl(resolved);
      },
      () => {
        /* placeholder retained; the durable transcript surfaces read errors */
      },
    );
    return () => {
      alive = false;
    };
  }, [attachment, loadImage]);
  return url === null ? (
    <span {...styling.props(styles.thumb)} aria-hidden />
  ) : (
    <img {...styling.props(styles.thumb)} src={url} alt={label} />
  );
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat + the locale seat. */
export type QueueDockProps = PropsRuntime<"conversation.input.dock"> &
  QueueDockInjected &
  PropsLocale<"conversation">;

/**
 * Queue strip: one item renders directly; multiple items default to a
 * collapsible count header; an empty queue renders nothing. Local submissions
 * show sending status and disabled actions until their Host queue rows arrive.
 */
export function QueueDock({
  useSession,
  useProjection,
  updateQueue,
  notify,
  loadImage,
  t,
}: QueueDockProps) {
  const inbox = useProjection("inbox") as unknown as InboxState | undefined;
  const queue = inbox?.["next-turn"] ?? EMPTY_QUEUE;
  const pendingSubmissions = useSession((s) => s.pendingSubmissions);
  const pendingQueue = useMemo(() => {
    const admitted = new Set(
      queue.flatMap(({ source }) => (source.kind === "user" && "rpcId" in source ? [source.rpcId] : [])),
    );
    return pendingSubmissions.filter(
      (submission) => submission.placement === "queued" && !admitted.has(submission.requestId),
    );
  }, [pendingSubmissions, queue]);
  const rowCount = queue.length + pendingQueue.length;
  const running = useSession((s) => s.running);
  const queueMutable = useSession(
    (s) => s.subagent === null || s.subagent.address.mode === "continuable",
  );
  const [editing, setEditing] = useState<{ id: MessageId; text: string } | null>(null);
  const [busy, setBusy] = useState<MessageId | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const listId = useId();
  // labels 按 locale revision 稳定（官方 MarkdownText 在它上面 memo 渲染缓存）。
  // 队列行的 chip 不可点（没有 owner 动作），但仍渲染成 chip。
  const labels = useMemo(() => markdownLabels(t), [t]);

  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true);
    if (editing !== null && (!queueMutable || !queue.some((row) => row.id === editing.id)))
      setEditing(null);
  }, [collapsed, editing, queue, queueMutable, rowCount]);

  if (rowCount === 0) return null;

  const interactionActive = queueMutable && (editing !== null || busy !== null);
  const expanded = !collapsed || interactionActive;
  const listVisible = rowCount === 1 || expanded;

  const applyAction = async (
    itemId: MessageId,
    action: QueueAction,
    failure: string,
  ): Promise<boolean> => {
    setBusy(itemId);
    try {
      await updateQueue(itemId, action);
      return true;
    } catch {
      notify("error", failure);
      return false;
    } finally {
      setBusy((current) => (current === itemId ? null : current));
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === "") return;
    if (
      await applyAction(
        editing.id,
        { kind: "edit", content: [{ type: "text", text: editing.text }] },
        t("queue.editFailed"),
      )
    )
      setEditing(null);
  };

  return (
    <div {...styling.props(styles.dock)} data-queue-dock="">
      <div {...styling.props(styles.panel)}>
        {rowCount > 1 && (
          <button
            type="button"
            {...styling.props(styles.header)}
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={interactionActive}
            onClick={() => {
              setCollapsed((value) => !value);
            }}
          >
            <span {...styling.props(styles.lead)} aria-hidden>
              <IconQueueOutline14 />
            </span>
            <span {...styling.props(styles.count)}>{t("queue.count", { n: rowCount })}</span>
            {!listVisible && pendingQueue.length > 0 && (
              <span {...styling.props(styles.status)} role="status">
                {t("queue.sending")}
              </span>
            )}
            <span {...styling.props(styles.chevron)} aria-hidden>
              {expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
            </span>
          </button>
        )}
        <ul id={listId} {...styling.props(styles.list)} hidden={!listVisible}>
          {listVisible &&
            queue.map((row) => {
              const attachments = queueAttachments(row.content);
              const rowText = queueRowTextOf(row.content);
              return (
                <li key={row.id} {...styling.props(styles.row)} data-queue-row="">
                  {/* Single-item strip has no count header, so the row itself carries the queue glyph. */}
                  {rowCount === 1 && (
                    <span {...styling.props(styles.lead)} aria-hidden>
                      <IconQueueOutline14 />
                    </span>
                  )}
                  {editing?.id === row.id ? (
                    <input
                      autoFocus
                      {...styling.props(styles.editor)}
                      aria-label={t("queue.edit")}
                      value={editing.text}
                      onChange={(event) => {
                        setEditing({ id: row.id, text: event.currentTarget.value });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setEditing(null);
                          return;
                        }
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void saveEdit();
                        }
                      }}
                    />
                  ) : (
                    <>
                      {attachments.length > 0 && (
                        <span {...styling.props(styles.attachments)} data-queue-attachments="">
                          {attachments.map((item, index) =>
                            item.type === "image" ? (
                              <QueueThumb
                                key={`${item.attachment.attachmentId}:${index}`}
                                attachment={item.attachment}
                                loadImage={loadImage}
                                label={t("queue.image")}
                              />
                            ) : (
                              <QueueFile
                                key={`${item.attachment.attachmentId}:${item.attachment.name}:${index}`}
                                attachment={item.attachment}
                                label={t("queue.file", { name: item.attachment.name })}
                              />
                            ),
                          )}
                        </span>
                      )}
                      <span {...styling.props(styles.preview)}>
                        <ReferenceMarkdown text={queueTextOf(rowText)} labels={labels} />
                      </span>
                    </>
                  )}
                  {queueMutable && (
                    <div {...styling.props(styles.actions)}>
                      {editing?.id === row.id ? (
                        <>
                          <Tooltip label={t("queue.save")} side="bottom" delayMs={500}>
                            <button
                              type="button"
                              {...styling.props(styles.action)}
                              aria-label={t("queue.save")}
                              disabled={busy !== null || editing.text.trim() === ""}
                              onClick={() => {
                                void saveEdit();
                              }}
                            >
                              <IconCheckOutline16 size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip label={t("queue.cancelEdit")} side="bottom" delayMs={500}>
                            <button
                              type="button"
                              {...styling.props(styles.action)}
                              aria-label={t("queue.cancelEdit")}
                              disabled={busy !== null}
                              onClick={() => {
                                setEditing(null);
                              }}
                            >
                              <IconCloseOutline16 size={14} />
                            </button>
                          </Tooltip>
                        </>
                      ) : (
                        <>
                          <Tooltip
                            label={t("queue.edit")}
                            side="bottom"
                            delayMs={500}
                            disabled={rowText.text === null}
                          >
                            <button
                              type="button"
                              {...styling.props(styles.action)}
                              aria-label={t("queue.edit")}
                              // Disabled buttons fire no hover events, so the
                              // unsupported hint stays a native title.
                              title={rowText.text === null ? t("queue.edit.unsupported") : undefined}
                              disabled={busy !== null || rowText.text === null}
                              onClick={() => {
                                if (rowText.text !== null)
                                  setEditing({ id: row.id, text: rowText.text });
                              }}
                            >
                              <IconEditOutline16 size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip label={t("queue.remove")} side="bottom" delayMs={500}>
                            <button
                              type="button"
                              {...styling.props(styles.action)}
                              aria-label={t("queue.remove")}
                              disabled={busy !== null}
                              onClick={() => {
                                void applyAction(
                                  row.id,
                                  { kind: "remove" },
                                  t("queue.removeFailed"),
                                );
                              }}
                            >
                              <IconTrashOutline16 size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip
                            label={t("queue.steer")}
                            side="bottom"
                            delayMs={500}
                            disabled={!running}
                          >
                            <button
                              type="button"
                              {...styling.props(styles.action)}
                              aria-label={t("queue.steer")}
                              title={running ? undefined : t("queue.steer.unavailable")}
                              disabled={busy !== null || !running}
                              onClick={() => {
                                void applyAction(row.id, { kind: "steer" }, t("queue.steerFailed"));
                              }}
                            >
                              <IconSendOutline14 />
                            </button>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          {listVisible &&
            pendingQueue.map((submission) => {
              return (
                <li
                  key={submission.requestId}
                  className={styling.className(styles.row, styles.pendingRow)}
                  data-queue-row=""
                  data-submission-echo=""
                >
                  {rowCount === 1 && (
                    <span {...styling.props(styles.lead)} aria-hidden>
                      <IconQueueOutline14 />
                    </span>
                  )}
                  {submission.attachments.length > 0 && (
                    <span {...styling.props(styles.attachments)} data-queue-attachments="">
                      {submission.attachments.map((attachment, index) =>
                        attachment.type === "image" ? (
                          <img
                            key={`${attachment.value.previewUrl}:${index}`}
                            {...styling.props(styles.thumb)}
                            src={attachment.value.previewUrl}
                            alt={t("queue.image")}
                          />
                        ) : (
                          <QueueFile
                            key={`${attachment.value.attachmentId}:${attachment.value.name}:${index}`}
                            attachment={attachment.value}
                            label={t("queue.file", { name: attachment.value.name })}
                          />
                        ),
                      )}
                    </span>
                  )}
                  <span {...styling.props(styles.preview)}>
                    <ReferenceMarkdown text={submission.text} labels={labels} />
                  </span>
                  <span {...styling.props(styles.status)} role="status">
                    {t("queue.sending")}
                  </span>
                  {queueMutable && (
                    <div {...styling.props(styles.actions)}>
                      <button
                        type="button"
                        {...styling.props(styles.action)}
                        aria-label={t("queue.edit")}
                        title={t("queue.sending")}
                        disabled
                      >
                        <IconEditOutline16 size={14} />
                      </button>
                      <button
                        type="button"
                        {...styling.props(styles.action)}
                        aria-label={t("queue.remove")}
                        title={t("queue.sending")}
                        disabled
                      >
                        <IconTrashOutline16 size={14} />
                      </button>
                      <button
                        type="button"
                        {...styling.props(styles.action)}
                        aria-label={t("queue.steer")}
                        title={t("queue.sending")}
                        disabled
                      >
                        <IconSendOutline14 />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
}

/** Registers queue actions backed by the session-scoped conversation service. */
export const queueDockEntry = {
  name: "conversation-queue-dock",
  inject: ["slots", "conversation", "sessions", "uiConversation"],
  apply(ctx: Context): void {
    ctx.slots.inject("conversation.input.dock", () =>
      ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "queue",
          order: 20,
          locale: NS,
          inject: (sessionId: SessionId): QueueDockInjected => {
            const actx = (ctx.sessions as unknown as ISessions).scope(sessionId);
            if (actx === undefined)
              throw new Error(`queue dock: session "${sessionId}" resolved no scope`);
            const conversation = actx.get("conversation");
            if (conversation === undefined)
              throw new Error("queue dock: conversation service unavailable");
            return {
              updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
              notify: (level, text) => {
                conversation.input.for(actx).notify(level, text);
              },
              loadImage: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment),
            };
          },
        },
        QueueDock,
      ),
    );
  },
};
