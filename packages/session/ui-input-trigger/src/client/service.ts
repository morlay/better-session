import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { InputTriggerSource } from "../types.ts";
import { InputTriggerController } from "./controller.ts";
import type { InputTriggerServiceContract } from "./contract.ts";

interface LiveState {
  readonly sources: InputTriggerSource[];

  readonly controllers: Map<SessionId, InputTriggerController>;
}

export class InputTriggerService extends Service implements InputTriggerServiceContract {
  static inject = ["sessions"];

  private readonly live: LiveState = { sources: [], controllers: new Map() };

  constructor(ctx: Context) {
    super(ctx, "inputTriggers");
    ctx.on("locale/change", () => {
      for (const controller of this.live.controllers.values()) controller.refreshOpenMenu();
    });
  }

  registerSource(src: InputTriggerSource): () => void {
    const { live } = this;
    if (live.sources.some((s) => s.trigger === src.trigger && s.name === src.name)) {
      throw new Error(`slash source "${src.trigger}${src.name}" is already registered`);
    }
    live.sources.push(src);
    for (const controller of live.controllers.values()) {
      try {
        controller.sourceAdded(src);
      } catch (error) {
        console.error(
          `[ui-input-trigger] source "${src.trigger}${src.name}" late-registration setup failed:`,
          error,
        );
      }
    }
    return () => {
      const at = live.sources.indexOf(src);
      if (at < 0) return;
      live.sources.splice(at, 1);
      for (const controller of live.controllers.values()) controller.sourceRemoved(src);
    };
  }

  sessionOf(actx: ClientContext): InputTriggerController {
    const sessions = this.sessions();
    const id = sessions.scopeOf(actx);
    if (id === undefined) throw new Error("slash.sessionOf requires a session scope");
    const { live } = this;
    const existing = live.controllers.get(id);
    if (existing !== undefined) return existing;
    const controller = new InputTriggerController({
      actx,
      sessionId: id,
      roster: {
        sources: (trigger) =>
          live.sources
            .filter((s) => s.trigger === trigger)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        all: () => live.sources,
      },
    });
    live.controllers.set(id, controller);
    actx.effect(
      () => () => {
        controller.dispose();
        live.controllers.delete(id);
      },
      "slash: session controller",
    );
    return controller;
  }

  private sessions(): ISessions {
    const sessions = this.ctx.get("sessions") as unknown as ISessions | undefined;
    if (sessions === undefined) throw new Error("ui-input-trigger: sessions service unavailable");
    return sessions;
  }
}
