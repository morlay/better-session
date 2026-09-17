import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, sep } from "node:path";

const MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && MISSING_CODES.has(code)) return undefined;
    throw error;
  }
}

function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase();
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive);
  const comparableRoot = comparablePath(root, caseSensitive);
  if (comparableTarget === comparableRoot) return true;
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparableTarget.startsWith(prefix);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== "win32",
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true;
  const rootInfo = await statIfPresent(root);
  if (rootInfo === undefined) return false;
  let ancestor = path;
  for (;;) {
    const ancestorInfo = await statIfPresent(ancestor);
    if (ancestorInfo !== undefined && sameIdentity(ancestorInfo, rootInfo)) return true;
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}
