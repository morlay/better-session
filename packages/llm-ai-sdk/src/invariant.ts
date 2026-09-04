import type { Context } from "@deepseek-ai/cordis";
import type { InvariantInstaller } from "@deepseek-ai/dsh-invariants";

const PACKAGE_NAME = "@morlay/dsh-llm-ai-sdk";

export const name = "llm-ai-sdk-invariant";

export const inject = ["invariants"];

const install: InvariantInstaller = () => {};

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
