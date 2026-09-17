import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import { InputTriggerService } from "./service.ts";
import type { MenuViewInjected } from "./slots.ts";
import { MenuView } from "./MenuView.tsx";
import { en, zh, type MenuKey } from "./locales.ts";

export { InputTriggerService } from "./service.ts";
export { InputTriggerController } from "./controller.ts";
export type { InputTriggerControllerDeps, SourceRoster } from "./controller.ts";
export type { MenuViewInjected } from "./slots.ts";
export type { MenuViewProps } from "./MenuView.tsx";
export type { MenuKey } from "./locales.ts";
export type {
  ArbitrateKey,
  ArbitrateOutcome,
  BeginCommandRequest,
  CandidateRequest,
  ClientSessionContext,
  CommandClaim,
  ConsumeTokenRequest,
  HeaderRequest,
  InsertReferenceRequest,
  PickOutcome,
  PickVia,
  ReferenceCodec,
  ReferenceInsert,
  InputTriggerCandidate,
  InputTriggerCrumb,
  InputTriggerPick,
  InputTriggerSource,
  SubmitAttachment,
  SubmitEnvelope,
  SubmitOutcome,
  TokenSpan,
  TriggerChar,
  TriggerGuard,
  TriggerPosition,
} from "../types.ts";
export type {
  DetectTrigger,
  ExactMatch,
  MenuEvent,
  MenuReduce,
  MenuState,
  TriggerHit,
} from "../core/contract.ts";
export type { InputTriggerServiceContract } from "./contract.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    inputTriggers: import("./contract.ts").InputTriggerServiceContract;
  }
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "slash.menu": MenuKey;
  }
}

const MENU_NS = "slash.menu";

export const inject = ["sessions", "locale"];

export function apply(ctx: ClientContext): void {
  ctx.plugin(InputTriggerService);
  ctx.effect(() => ctx.locale.register(MENU_NS, { zh, en }), "ui-input-trigger: menu dictionaries");
  ctx.inject(["slots", "inputTriggers", "sessions"], (scope: ClientContext) => {
    const inputTriggers = scope.inputTriggers;
    const sessions = scope.sessions as unknown as ISessions;
    scope.slots.inject("conversation.input.overlay", () =>
      scope.slots.register(
        {
          name: "conversation.input.overlay",
          id: "slash-menu",
          order: 0,
          locale: MENU_NS,
          inject: (sessionId): MenuViewInjected => {
            const actx = sessions.scope(sessionId);
            if (actx === undefined)
              throw new Error(`ui-input-trigger: session "${String(sessionId)}" resolved no scope`);
            const controller = inputTriggers.sessionOf(actx);
            return {
              menu: controller.menu,
              headers: controller.headers,
              onPick: (source, index, action) => {
                controller.pick(source, index, action);
              },
              onCrumb: (source, index) => {
                controller.pickCrumb(source, index);
              },
              onHover: (source, index) => {
                controller.hover(source, index);
              },
              onDismiss: () => {
                controller.dismiss();
              },
            };
          },
        },
        MenuView,
      ),
    );
  });
}
