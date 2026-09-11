import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** 工具包根（源码形态 `src/cli` 与构建形态 `dist/cli` 同深度）。 */
const APP_ROOT = resolve(import.meta.dirname, "..", "..");

/** 壳入口产物（Electron 加载的主进程）。 */
export const SHELL_ENTRY = join(APP_ROOT, "dist", "index.mjs");

/** Every file under a directory (the shell sources live in `src/`). */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Verify the shell build dev and bundle reuse. The build comes from
 * `pnpm build` (tsdown), never from these commands; a build older than its
 * sources is how a fixed shell silently fails to reach a packaged app — the app
 * then keeps the old behaviour and the fix looks broken. Say it out loud
 * instead of packaging the stale artifact.
 */
function checkShellBuild(): void {
  if (!existsSync(SHELL_ENTRY)) {
    throw new Error(`dsh-desktopify: shell build is missing ${SHELL_ENTRY}; run pnpm build`);
  }
  const built = statSync(SHELL_ENTRY).mtimeMs;
  const stale = filesUnder(join(APP_ROOT, "src")).filter((file) => statSync(file).mtimeMs > built);
  if (stale.length > 0) {
    console.warn(
      `dsh-desktopify: shell build is older than ${String(stale.length)} source file(s) ` +
        `(first: ${relative(APP_ROOT, stale[0] ?? "")}); run pnpm build — dev and bundle load ` +
        "the built shell, not the sources",
    );
  }
}

/** 构建壳产物；发布形态没有源码时直接使用随包构建结果。 */
export async function buildShell(): Promise<void> {
  if (!existsSync(join(APP_ROOT, "src", "index.ts"))) {
    if (!existsSync(SHELL_ENTRY)) {
      throw new Error(`dsh-desktopify: packaged shell build is missing ${SHELL_ENTRY}`);
    }
    console.log("dsh-desktopify: using the packaged shell build");
    return;
  }
  checkShellBuild();
}
