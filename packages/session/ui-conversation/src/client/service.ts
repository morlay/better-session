import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";

import type {
  ISessions,
  PendingSubmissionRetirement,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-file-upload/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ImageMediaType } from "@deepseek-ai/dsh-attachment";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
  DraftFileUpload,
} from "./contract/slots.ts";
import type { QueueAction, QueueItemId } from "./contract/queue.ts";
import type { ComposerBlocks } from "./contract/composer-blocks.ts";
import type {
  DraftAttachmentId,
  DraftAttachmentSerializationResult,
  SessionInputResolver,
  SubmitAttachment,
  SubmitOutcome,
} from "./contract/input.ts";
import type { InputSubmitMode } from "./contract/composer-submission.ts";

export interface IConversation {
  readonly input: SessionInputResolver;

  readonly blocks: ComposerBlocks;

  send(text: string): Promise<void>;

  updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void>;

  cancel(): Promise<void>;

  loadOlder(): Promise<void>;
}

function browserDraftAttachment(file: File): ComposerImageAttachment {
  return {
    kind: "image",
    id: randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

function probeDimensions(attachment: ComposerImageAttachment): void {
  if (typeof Image !== "function") return;
  const probe = new Image();
  probe.onload = () => {
    attachment.width = probe.naturalWidth;
    attachment.height = probe.naturalHeight;
  };
  probe.src = attachment.previewUrl;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setTimeout(resolve, 0);
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        setTimeout(resolve, 0);
      };
      const fallback = setTimeout(finish, 100);
      requestAnimationFrame(finish);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function base64ImageOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("conversation: image read failed"));
    };
    reader.readAsDataURL(file);
  });
}

export class UnsupportedImageMediaTypeError extends Error {
  readonly mediaType: string;

  constructor(mediaType: string) {
    super(`unsupported image media type: ${mediaType || "(empty)"}`);
    this.name = "UnsupportedImageMediaTypeError";
    this.mediaType = mediaType;
  }
}

export class ConversationController extends Service implements IConversation {
  readonly input: SessionInputResolver;

  readonly blocks: ComposerBlocks;

  readonly fileUploads: SnapshotStore<Record<string, DraftFileUpload>> = createSnapshotStore<
    Record<string, DraftFileUpload>
  >({});
  private readonly draftAttachments = new Map<DraftAttachmentId, ComposerAttachment>();
  private readonly fileUploadOperations = new Map<
    DraftAttachmentId,
    {
      readonly controller: AbortController;
      readonly done: Promise<void>;
    }
  >();
  private readonly pendingFileUploads = new Set<Promise<void>>();
  private readonly fileUploadQueue: Array<{
    readonly run: () => Promise<void>;
    readonly settle: () => void;
  }> = [];
  private activeFileUploads = 0;
  private readonly maxConcurrentFileUploads: number;

  constructor(
    ctx: Context,
    config: {
      input: SessionInputResolver;
      blocks: ComposerBlocks;
      maxConcurrentFileUploads: number;
    },
  ) {
    super(ctx, "conversation");
    this.input = config.input;
    this.blocks = config.blocks;
    this.maxConcurrentFileUploads = config.maxConcurrentFileUploads;
    ctx.effect(
      () => async () => {
        const operations = [...this.fileUploadOperations.values()];
        for (const operation of operations) operation.controller.abort();
        await Promise.allSettled(this.pendingFileUploads);
        this.fileUploadOperations.clear();
        this.fileUploadQueue.length = 0;
        for (const attachment of this.draftAttachments.values()) {
          if (attachment.kind === "image") revokePreview(attachment.previewUrl);
        }
        this.draftAttachments.clear();
        this.fileUploads.set({});
      },
      "conversation draft attachments",
    );
  }

  async send(text: string): Promise<void> {
    const session = this.scopedSession("send");
    const result = await session.prompt([{ type: "text", text }], "queue");
    if (!result.ok)
      throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`);
  }

  async sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    const attachments = this.resolveDraftAttachments(attachmentIds);
    if (attachments.length !== attachmentIds.length) {
      throw new Error(
        "conversation.sendSession: one or more draft attachments are no longer available",
      );
    }
    const uploads = this.fileUploads.getSnapshot();
    const uploadFor = (
      attachment: ComposerFileAttachment,
    ): Extract<DraftFileUpload, { status: "ready" }> => {
      const upload = uploads[attachment.id];
      if (upload === undefined || upload.status !== "ready") {
        throw new Error("conversation.sendSession: one or more files have not finished uploading");
      }
      return upload;
    };
    const pendingAttachments = attachments.map((attachment) =>
      attachment.kind === "image"
        ? {
            type: "image" as const,
            value: {
              previewUrl: attachment.previewUrl,
              ...(attachment.file.name === "" ? {} : { name: attachment.file.name }),
              ...(attachment.width === undefined ? {} : { width: attachment.width }),
              ...(attachment.height === undefined ? {} : { height: attachment.height }),
            },
          }
        : { type: "file" as const, value: uploadFor(attachment).file },
    );
    const serializeAttachments = (): Promise<Parameters<SessionFace["prompt"]>[0]> =>
      Promise.all(
        attachments.map(async (attachment) =>
          attachment.kind === "image"
            ? { type: "image" as const, ...(await this.encodeImage(attachment.file)) }
            : { type: "file" as const, receiptId: uploadFor(attachment).receiptId },
        ),
      );
    const snapshot = session.getSnapshot();
    if (snapshot.subagent !== null) {
      const uploaded = await serializeAttachments();
      const content = [...uploaded, ...(text === "" ? [] : [{ type: "text" as const, text }])];
      const result = await session.prompt(content, mode, signal);
      return result.ok ? { kind: "success" } : { kind: "error" };
    }
    let finishRetirement: ((retirement: PendingSubmissionRetirement) => void) | undefined;
    const retirement =
      attachments.length === 0
        ? undefined
        : new Promise<PendingSubmissionRetirement>((resolve) => {
            finishRetirement = resolve;
          });
    const submission = session.beginSubmission({
      mode,
      text,
      attachments: pendingAttachments,
      onRetire: (settlement) => {
        this.settleSubmittedAttachments(session.sessionId, attachments, settlement);
        finishRetirement?.(settlement);
      },
    });
    let content: Parameters<SessionFace["prompt"]>[0];
    try {
      await nextPaint();
      const uploaded = await serializeAttachments();
      content = [...uploaded, ...(text === "" ? [] : [{ type: "text" as const, text }])];
    } catch (error) {
      submission.abandon();
      throw error;
    }
    const result = await session.prompt(content, mode, signal, submission.requestId);
    if (!result.ok) return { kind: "error" };
    if (retirement !== undefined && (await retirement).reason !== "observed")
      return { kind: "error" };
    return { kind: "success" };
  }

  createDrafts(sessionId: SessionId, files: readonly File[]): readonly ComposerAttachment[] {
    return files.map((file) => {
      if (isImageMediaType(file.type)) {
        const attachment = browserDraftAttachment(file);
        this.draftAttachments.set(attachment.id, attachment);
        probeDimensions(attachment);
        return attachment;
      }
      const attachment: ComposerFileAttachment = {
        kind: "file",
        id: randomUUID() as DraftAttachmentId,
        file,
      };
      this.draftAttachments.set(attachment.id, attachment);
      this.beginFileUpload(sessionId, attachment);
      return attachment;
    });
  }

  retryFileUpload(sessionId: SessionId, id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id);
    if (attachment === undefined || attachment.kind !== "file") return;
    if (this.fileUploads.getSnapshot()[id]?.status !== "error") return;
    this.beginFileUpload(sessionId, attachment);
  }

  rebindDraftFiles(sessionId: SessionId, ids: readonly DraftAttachmentId[]): void {
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id);
      if (attachment?.kind === "file") this.beginFileUpload(sessionId, attachment);
    }
  }

  private beginFileUpload(sessionId: SessionId, attachment: ComposerFileAttachment): void {
    this.fileUploadOperations.get(attachment.id)?.controller.abort();
    const controller = new AbortController();
    this.fileUploads.update((draft) => {
      draft[attachment.id] = { status: "uploading", loaded: 0 };
    });
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.fileUploadOperations.set(attachment.id, { controller, done });
    this.pendingFileUploads.add(done);
    void done.then(() => {
      this.pendingFileUploads.delete(done);
    });
    const run = async (): Promise<void> => {
      try {
        if (
          controller.signal.aborted ||
          this.fileUploadOperations.get(attachment.id)?.controller !== controller
        )
          return;
        const result = await this.ctx.fileUpload.upload(
          sessionId,
          attachment.file,
          attachment.file.name === "" ? undefined : attachment.file.name,
          controller.signal,
          (progress) => {
            if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return;
            this.fileUploads.update((draft) => {
              if (!(attachment.id in draft)) return;
              draft[attachment.id] = {
                status: "uploading",
                loaded: progress.loaded,
                ...(progress.total === undefined ? {} : { total: progress.total }),
              };
            });
          },
        );
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return;
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return;
          draft[attachment.id] = result.ok
            ? { status: "ready", receiptId: result.value.receiptId, file: result.value.file }
            : { status: "error", message: result.error.message };
        });
      } catch (error) {
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return;
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return;
          draft[attachment.id] = {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        });
      } finally {
        if (this.fileUploadOperations.get(attachment.id)?.controller === controller) {
          this.fileUploadOperations.delete(attachment.id);
        }
      }
    };
    this.fileUploadQueue.push({ run, settle });
    this.pumpFileUploads();
  }

  private pumpFileUploads(): void {
    while (this.activeFileUploads < this.maxConcurrentFileUploads) {
      const task = this.fileUploadQueue.shift();
      if (task === undefined) return;
      this.activeFileUploads += 1;
      void task.run().finally(() => {
        this.activeFileUploads -= 1;
        task.settle();
        this.pumpFileUploads();
      });
    }
  }

  resolveDraftAttachments(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = [];
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id);
      if (attachment !== undefined) attachments.push(attachment);
    }
    return attachments;
  }

  async serializeDraftAttachments(
    attachmentIds: readonly DraftAttachmentId[],
  ): Promise<DraftAttachmentSerializationResult> {
    const attachments = this.resolveDraftAttachments(attachmentIds);
    if (attachments.length !== attachmentIds.length) {
      throw new Error(
        "conversation.serializeDraftAttachments: one or more draft attachments are no longer available",
      );
    }
    const uploads = this.fileUploads.getSnapshot();
    return {
      attachments: await Promise.all(
        attachments.map(async (attachment) => {
          if (attachment.kind === "image")
            return { type: "image" as const, ...(await this.encodeImage(attachment.file)) };
          const upload = uploads[attachment.id];
          if (upload === undefined || upload.status !== "ready") {
            throw new Error(
              "conversation.serializeDraftAttachments: one or more files have not finished uploading",
            );
          }
          return { type: "file" as const, receiptId: upload.receiptId };
        }),
      ),
    };
  }

  releaseDraftAttachment(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id);
    if (attachment === undefined) return;
    const operation = this.fileUploadOperations.get(id);
    this.fileUploadOperations.delete(id);
    operation?.controller.abort();
    this.draftAttachments.delete(id);
    if (attachment.kind === "image") {
      revokePreview(attachment.previewUrl);
      return;
    }

    this.fileUploads.set(
      Object.fromEntries(
        Object.entries(this.fileUploads.getSnapshot()).filter(([key]) => key !== id),
      ),
    );
  }

  releaseDraftAttachments(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftAttachment(attachment.id);
  }

  async updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void> {
    const session = this.scopedSession("updateQueue");
    const result = await session.updateQueue(itemId, action);
    if (!result.ok) {
      if (
        action.kind === "steer" &&
        (result.error.code === "session/steer-unavailable" ||
          result.error.code === "session/queue-item-not-found")
      )
        return;
      throw new Error(
        `conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`,
      );
    }
  }

  async cancel(): Promise<void> {
    const session = this.scopedSession("cancel");
    const result = await session.cancel();
    if (!result.ok)
      throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`);
  }

  async loadOlder(): Promise<void> {
    await this.scopedSession("loadOlder").loadOlder();
  }

  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op);
    const binding = this.requireSessions().binding(id);
    if (binding === undefined)
      throw new Error(`conversation.${op}: session "${id}" resolved no binding`);
    return binding.session;
  }

  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx);
    if (id === undefined) {
      throw new Error(
        `conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`,
      );
    }
    return id;
  }

  private requireSessions(): ISessions {
    const sessions = this.ctx.get("sessions") as unknown as ISessions | undefined;
    if (sessions === undefined) throw new Error("conversation: sessions service unavailable");
    return sessions;
  }

  private settleSubmittedAttachments(
    sessionId: SessionId,
    attachments: readonly ComposerAttachment[],
    retirement: PendingSubmissionRetirement,
  ): void {
    if (retirement.reason !== "observed") return;
    const uiConversation = this.ctx.get("uiConversation");
    let observedIndex = 0;
    for (const attachment of attachments) {
      const live = this.draftAttachments.get(attachment.id);
      const ref = retirement.attachments[observedIndex++];
      if (live === undefined) continue;
      if (attachment.kind === "file") {
        this.releaseDraftAttachment(attachment.id);
        continue;
      }
      this.draftAttachments.delete(attachment.id);
      if (
        ref !== undefined &&
        "mediaType" in ref &&
        uiConversation?.seedImageUrl(sessionId, ref, attachment.previewUrl) === true
      )
        continue;
      revokePreview(attachment.previewUrl);
    }
  }

  private async encodeImage(
    file: File,
  ): Promise<Omit<Extract<SubmitAttachment, { type: "image" }>, "type">> {
    return {
      mediaType: imageMediaType(file.type),
      data: await base64ImageOf(file),
      ...(file.name === "" ? {} : { name: file.name }),
    };
  }
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
    case "image/gif":
      return value;
    default:
      throw new UnsupportedImageMediaTypeError(value);
  }
}

function isImageMediaType(value: string): boolean {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}

function revokePreview(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
