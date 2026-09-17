import type { Context } from "@deepseek-ai/cordis";
import type {
  ISessions,
  SessionBinding,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import { queueReadFaceOf } from "./queue-store.ts";
import type {
  DraftAttachmentId,
  DraftAttachmentSerializationResult,
  InputTriggerController,
  SessionInputResolver,
  SessionInput,
  SubmitOutcome,
} from "../contract/input.ts";
import type { ComposerKeyboard } from "../contract/draft-editor.ts";
import type { InputSubmitMode } from "../contract/composer-submission.ts";
import type { PopupDismissFace } from "./facade.ts";
import { SessionInputShell } from "./facade.ts";
import { insertTextOf, referenceTextOf } from "./reference-text.ts";

interface CommandFace {
  popupFor(actx: Context): PopupDismissFace;
}

interface InputTriggerServiceFace {
  sessionOf(actx: Context): InputTriggerController;
}

interface ConversationAttachmentFace {
  sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome>;
  serializeDraftAttachments(
    attachmentIds: readonly DraftAttachmentId[],
  ): Promise<DraftAttachmentSerializationResult>;
  releaseDraftAttachment(id: DraftAttachmentId): void;
}

export class InputHub implements SessionInputResolver {
  private readonly shells = new Map<SessionId, SessionInputShell>();

  constructor(
    private readonly rootCtx: Context,
    private readonly t: TranslateNS<"conversation">,
  ) {}

  for(actx: Context): SessionInput {
    const sessions = this.sessions();
    const id = sessions.scopeOf(actx);
    if (id === undefined) throw new Error("conversation.input.for requires a session scope");
    return this.shell(id);
  }

  shellFor(binding: SessionBinding): SessionInputShell {
    const existing = this.shells.get(binding.sessionId);
    if (existing !== undefined) return existing;
    const { sessionId: id, session, ctx: actx } = binding;
    const shell = new SessionInputShell({
      actx,
      inputTriggers: () => this.controller(actx),
      popup: () => this.popup(actx),
      queue: queueReadFaceOf(session),

      cwd: () => this.sessions().list.getSnapshot().byId[id]?.cwd,
      defaultSink: (text, attachmentIds, mode, signal) =>
        this.sink(session, text, attachmentIds, mode, signal),
      steerQueue: () => {
        void this.steerQueue(session, shell);
      },
      commandAttachments: {
        serialize: async (ids) => {
          const result = await this.conversation().serializeDraftAttachments(ids);
          return result.attachments;
        },

        release: (ids) => {
          const conversation = this.rootCtx.get("conversation") as
            | ConversationAttachmentFace
            | undefined;
          for (const attachmentId of ids) conversation?.releaseDraftAttachment(attachmentId);
        },
        unsupportedNotice: (token) =>
          this.t("command.attachmentsUnsupported", {
            command: token.trim().replace(/^\//u, ""),
          }),
      },
    });
    this.shells.set(id, shell);

    actx.effect(() => {
      const offs = [
        actx.on("slash/input-begin-command", (req) =>
          shell.beginCommand(req.claim, req.span) ? true : undefined,
        ),
        actx.on("slash/input-insert-reference", (req) =>
          shell.insertReference(referenceTextOf(req.reference), req.span) ? true : undefined,
        ),
        actx.on("slash/input-consume-token", (req) =>
          shell.consumeToken(req.guard) ? true : undefined,
        ),
        actx.on("slash/input-insert-text", (req) =>
          shell.insertText(insertTextOf(req.text), req.span, req.continue === true)
            ? true
            : undefined,
        ),
      ];
      return () => {
        for (const off of offs) off();
        const drafts = shell.dispose();
        this.shells.delete(id);
        const conversation = this.rootCtx.get("conversation") as
          | ConversationAttachmentFace
          | undefined;
        for (const attachmentId of drafts) conversation?.releaseDraftAttachment(attachmentId);
      };
    }, "conversation.input: session shell");
    return shell;
  }

  shell(id: SessionId): SessionInputShell {
    const existing = this.shells.get(id);
    if (existing !== undefined) return existing;
    const binding = this.sessions().binding(id);
    if (binding === undefined)
      throw new Error(`conversation.input: session "${id}" resolved no binding`);
    return this.shellFor(binding);
  }

  keyboard(id: SessionId): ComposerKeyboard {
    return this.shell(id);
  }

  canPickFiles(id: SessionId): boolean {
    return this.shells.get(id)?.canPickFiles() === true;
  }

  pickFiles(id: SessionId): void {
    this.shells.get(id)?.pickFiles();
  }

  inputTriggers(id: SessionId): InputTriggerController | undefined {
    const actx = this.sessions().scope(id);
    return actx === undefined ? undefined : this.controller(actx);
  }

  private sink(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome> {
    if (text === "" && attachmentIds.length === 0) return Promise.resolve({ kind: "success" });
    return this.conversation().sendSession(session, text, attachmentIds, mode, signal);
  }

  private async steerQueue(session: SessionFace, shell: SessionInputShell): Promise<void> {
    const queued = session.getSnapshot().queue.filter((item) => item.placement === "queued");
    if (queued.length === 0) return;
    for (const item of queued) {
      const result = await session.updateQueue(item.id, { kind: "steer" });
      if (result.ok) continue;
      if (
        result.error.code === "session/steer-unavailable" ||
        result.error.code === "session/queue-item-not-found"
      )
        return;
      shell.notify("error", this.t("queue.steerFailed"));
      return;
    }
  }

  private controller(actx: Context): InputTriggerController | undefined {
    const inputTriggers = this.rootCtx.get("inputTriggers") as InputTriggerServiceFace | undefined;
    return inputTriggers?.sessionOf(actx);
  }

  private popup(actx: Context): PopupDismissFace | undefined {
    const command = this.rootCtx.get("commandUi") as CommandFace | undefined;
    return command?.popupFor(actx);
  }

  private sessions(): ISessions {
    const sessions = this.rootCtx.get("sessions") as unknown as ISessions | undefined;
    if (sessions === undefined) throw new Error("conversation.input: sessions service unavailable");
    return sessions;
  }

  private conversation(): ConversationAttachmentFace {
    const conversation = this.rootCtx.get("conversation") as ConversationAttachmentFace | undefined;
    if (conversation === undefined)
      throw new Error("conversation.input: conversation service unavailable");
    return conversation;
  }
}
