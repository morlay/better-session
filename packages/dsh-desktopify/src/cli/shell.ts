import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** 工具包根（源码形态 `src/cli` 与构建形态 `dist/cli` 同深度）。 */
const APP_ROOT = resolve(import.meta.dirname, "..", "..");

/** 壳入口产物（Electron 加载的主进程）。 */
export const SHELL_ENTRY = join(APP_ROOT, "dist", "index.mjs");

/** 构建壳产物；发布形态没有源码时直接使用随包构建结果。 */
export async function buildShell(): Promise<void> {
  if (!existsSync(join(APP_ROOT, "src", "index.ts"))) {
    if (!existsSync(SHELL_ENTRY)) {
      throw new Error(`dsh-desktopify: packaged shell build is missing ${SHELL_ENTRY}`);
    }
    console.log("dsh-desktopify: using the packaged shell build");
    return;
  }
}
