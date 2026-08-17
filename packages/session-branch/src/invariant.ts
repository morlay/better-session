/**
 * Package-owned invariant companion for `@morlay/session-branch`.
 * @module @morlay/session-branch/invariant
 */

import type { Context } from "@deepseek-ai/cordis";
import type { InvariantInstaller } from "@deepseek-ai/dsh-invariants";

const PACKAGE_NAME = "@morlay/session-branch";

/** Cordis companion plugin name. */
export const name = "session-branch-invariant";
/** Service required before the companion can reserve package ownership. */
export const inject = ["invariants"];

/**
 * No runtime invariant: branch semantics (rewind / forkFrom / boundary
 * anchoring) are validated by contract tests; this package exposes no
 * continuously observable in-process relation.
 */
const install: InvariantInstaller = () => {};

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
