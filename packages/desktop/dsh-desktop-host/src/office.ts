/**
 * Desktop-profile composition of the bundled authoring dependencies.
 *
 * The only divergence from upstream `apps/desktop-host/src/office.ts` is the missing
 * `@deepseek-ai/dsh-skill-office` mount: the profile still gets the bundled payload installer
 * (`workspace-dependencies`, imported from upstream below) but registers no docx / pptx / xlsx
 * skills. Name, config fields, and the argv contract stay upstream's, so the host entry sees no
 * difference. `tsdown` inlines the upstream module into `dist`, so the published package carries this
 * composition instead of resolving a source path at run time.
 */

import type { Context } from "@deepseek-ai/cordis";
import * as workspaceDependencies from "../../../../vendor/deepseek-harness/apps/desktop-host/src/workspace-dependencies.ts";

/** Loader identity for the application-owned workspace dependency composition. */
export const name = "desktop-office";
/** Application-selected bundled payload and installation directories. */
export interface Config {
  /** Bundled payload directory holding the primary runtime. */
  readonly source: string;
  /** Harness-home directory where workspace dependencies are installed. */
  readonly root: string;
}

/**
 * Enable the bundled authoring dependencies in the Desktop profile.
 * @param ctx - Profile scope; child plugins declare their own service requirements.
 * @param config - Bundled payload source and Harness-home installation root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(workspaceDependencies, config);
}
