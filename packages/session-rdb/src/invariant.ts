/* jscpd:ignore-start */
import type { Context } from "@deepseek-ai/cordis";
import type { InvariantInstaller } from "@deepseek-ai/dsh-invariants";

const PACKAGE_NAME = "@morlay/session-rdb";

export const name = "session-rdb-invariant";

export const inject = ["invariants"];

const install: InvariantInstaller = () => {};

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
