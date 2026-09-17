import { OFFICIAL_PROFILE_PACKAGES } from "./official-packages.generated.ts";

export const OFFICIAL_RUNTIME_PACKAGES: readonly string[] = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-desktop-host",
  ...OFFICIAL_PROFILE_PACKAGES,
];

export const OFFICIAL_PROFILE_BUNDLES: readonly string[] = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
];
