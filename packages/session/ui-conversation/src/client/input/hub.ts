import type { Context } from "@deepseek-ai/cordis";
import type {
  ISessions,
  SessionBinding,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import type { InboxState } from "@deepseek-ai/dsh-agent/types";
import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type {
  DraftAttachmentId,
  DraftAttachmentSerializationResult,
  InputTriggerController,
  SubmitOutcome,
} from "../../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/input.ts";
// fork 扩宽的那两项（带 `restoreDraft` 的 facade 与其解析器）来自本地契约文件。
import type { SessionInput, SessionInputResolver } from "../contract/input.ts";
import type { ComposerKeyboard } from "../../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/draft-editor.ts";
import type { InputSubmitMode } from "../../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/composer-submission.ts";
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
  private readonly shells = new WeakMap<SessionBinding, SessionInputShell>();

  constructor(
    private readonly rootCtx: Context,
    private readonly t: TranslateNS<"conversation">,
  ) {}

  for(actx: Context): SessionInput {
    const sessions = this.sessions();
    const session = sessions.sessionOf(actx);
    const binding = session === undefined ? undefined : sessions.binding(session.sessionId);
    if (binding === undefined || binding.session !== session) {
      throw new Error("conversation.input.for requires a retained Session scope");
    }
    return this.shellFor(binding);
  }

  shellFor(binding: SessionBinding): SessionInputShell {
    const existing = this.shells.get(binding);
    if (existing !== undefined) return existing;
    const { sessionId: id, session, ctx: actx } = binding;
    const shell = new SessionInputShell({
      actx,
      inputTriggers: () => this.controller(actx),
      popup: () => this.popup(actx),
      inbox: session.projections.faceOf("inbox") as ObservableSnapshot<InboxState | undefined>,

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
    this.shells.set(binding, shell);

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
        this.shells.delete(binding);
        const conversation = this.rootCtx.get("conversation") as
          | ConversationAttachmentFace
          | undefined;
        for (const attachmentId of drafts) conversation?.releaseDraftAttachment(attachmentId);
      };
    }, "conversation.input: session shell");
    return shell;
  }

  shell(id: SessionId): SessionInputShell {
    const binding = this.sessions().binding(id);
    if (binding === undefined)
      throw new Error(`conversation.input: session "${id}" resolved no binding`);
    return this.shellFor(binding);
  }

  keyboard(id: SessionId): ComposerKeyboard {
    return this.shell(id);
  }

  canPickFiles(id: SessionId): boolean {
    const binding = this.sessions().binding(id);
    return binding !== undefined && this.shells.get(binding)?.canPickFiles() === true;
  }

  pickFiles(id: SessionId): void {
    const binding = this.sessions().binding(id);
    if (binding !== undefined) this.shells.get(binding)?.pickFiles();
  }

  inputTriggers(id: SessionId): InputTriggerController | undefined {
    const binding = this.sessions().binding(id);
    return binding === undefined ? undefined : this.controller(binding.ctx);
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
    const inbox = session.projections.faceOf("inbox").getSnapshot() as InboxState | undefined;
    const queued = inbox?.["next-turn"] ?? [];
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
    if (this.sessions().sessionOf(actx) === undefined) return undefined;
    const inputTriggers = this.rootCtx.get("inputTriggers") as InputTriggerServiceFace | undefined;
    return inputTriggers?.sessionOf(actx);
  }

  private popup(actx: Context): PopupDismissFace | undefined {
    if (this.sessions().sessionOf(actx) === undefined) return undefined;
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
