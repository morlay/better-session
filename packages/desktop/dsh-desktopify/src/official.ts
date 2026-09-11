/**
 * Official `@deepseek-ai/*` surface maintained by the desktopify tool.
 *
 * The tool assembles the runtime project (dev project / deploy closure) from
 * the app workspace's own `dependencies` plus the official packages the tool
 * maintains: `@deepseek-ai/dsh` (the installation anchor the upstream
 * desktop host resolves profile bundles from), `@deepseek-ai/dsh-desktop-host`
 * (the byte-pipe backend), and the peer packages the desktop composition
 * loads (dsh-base / dsh-web-app bundles plus the desktop host's own
 * dependencies) — `pnpm deploy --prod` does not install peerDependencies, so
 * the tool injects them explicitly. dsh-base and dsh-web-app resolve
 * automatically through the dsh dependency tree.
 * @module @morlay/dsh-desktopify
 */

/** Official peer packages the desktop composition needs in the closure. */
export const OFFICIAL_PEER_PACKAGES: readonly string[] = [
  "@deepseek-ai/cordis-plugin-group",
  "@deepseek-ai/dsh-anonymous-user-id",
  "@deepseek-ai/dsh-authorization",
  "@deepseek-ai/dsh-bash-local",
  "@deepseek-ai/dsh-code-runtime",
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-experimental-agent-team",
  "@deepseek-ai/dsh-experimental-client-ui-agent-team",
  "@deepseek-ai/dsh-experimental-tool-agent-team",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-hook-protocol",
  "@deepseek-ai/dsh-jobs",
  "@deepseek-ai/dsh-output-retention",
  "@deepseek-ai/dsh-sandbox",
  "@deepseek-ai/dsh-sdk-protocol",
  "@deepseek-ai/dsh-session-query",
  "@deepseek-ai/dsh-session-telemetry",
  "@deepseek-ai/dsh-session-title-llm",
  "@deepseek-ai/dsh-shell",
  "@deepseek-ai/dsh-spill",
  "@deepseek-ai/dsh-subagent-in-process-driver",
  "@deepseek-ai/dsh-util-time",
  "@deepseek-ai/dsh-util-workspace-path",
  "@deepseek-ai/dsh-workflow",
];

/** Official packages the tool injects into every runtime project it assembles. */
export const OFFICIAL_RUNTIME_PACKAGES: readonly string[] = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-desktop-host",
  ...OFFICIAL_PEER_PACKAGES,
];

/** Official profile bundles merged ahead of the app's own bundles. */
export const OFFICIAL_PROFILE_BUNDLES: readonly string[] = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
];
