/**
 * Official `@deepseek-ai/*` surface maintained by the desktopify tool.
 *
 * The tool assembles the runtime project (dev project / deploy closure) from
 * the app workspace's own `dependencies` plus the official packages the tool
 * maintains: `@deepseek-ai/dsh` (the installation anchor the upstream
 * desktop host resolves profile bundles from), `@deepseek-ai/dsh-desktop-host`
 * (the byte-pipe backend), and every official plugin the desktop composition
 * loads — `pnpm deploy --prod` does not install peerDependencies, so the tool
 * injects them explicitly. The plugin set is generated from the upstream
 * bundle patches (dsh-base / dsh-web-app `cordis.patch.yml`) instead of being
 * maintained by hand; dsh-base and dsh-web-app themselves resolve through the
 * dsh dependency tree.
 * @module @morlay/dsh-desktopify
 */

import { OFFICIAL_PROFILE_PACKAGES } from "./official-packages.generated.ts";

/** Official packages the tool injects into every runtime project it assembles. */
export const OFFICIAL_RUNTIME_PACKAGES: readonly string[] = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-desktop-host",
  ...OFFICIAL_PROFILE_PACKAGES,
];

/** Official profile bundles merged ahead of the app's own bundles. */
export const OFFICIAL_PROFILE_BUNDLES: readonly string[] = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
];
