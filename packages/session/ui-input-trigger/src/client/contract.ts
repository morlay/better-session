import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { InputTriggerSource } from "../types.ts";
import type { InputTriggerController } from "./controller.ts";

export interface InputTriggerServiceContract {
  registerSource(src: InputTriggerSource): () => void;

  sessionOf(actx: ClientContext): InputTriggerController;
}
