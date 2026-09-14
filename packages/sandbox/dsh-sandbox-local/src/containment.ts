/**
 * 目标是否位于某个可写根之下的判定。
 *
 * 语义与上游 `@deepseek-ai/dsh-fs-sandbox/src/containment.ts` 对齐（canonical 拼写走
 * 词法快路径，别名/大小写差异由文件系统身份兜底）；本包自带一份，是因为该模块只存在于
 * 上游包的 `src/` 深处，而发布产物（`lib/`）与安装态 profile 的模块解析都不覆盖深路径。
 * @module @morlay/dsh-sandbox-local/containment
 */

import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, sep } from "node:path";

/** 视为“路径不存在”的错误码：只有它们能让祖先遍历继续。 */
const MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** stat 一次，缺失返回 undefined；其它失败（权限、I/O）继续抛出。 */
async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && MISSING_CODES.has(code)) return undefined;
    throw error;
  }
}

/** 按大小写敏感性归一用于比较的拼写。 */
function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase();
}

/** 词法包含判定（目标可带尚不存在的后缀）。 */
function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive);
  const comparableRoot = comparablePath(root, caseSensitive);
  if (comparableTarget === comparableRoot) return true;
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparableTarget.startsWith(prefix);
}

/** 两次 stat 是否指向同一个文件系统对象。 */
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * 判断 canonical 目标是否就是某个根或位于其下。
 * 拼写不同时（Windows 长名/8.3 别名、大小写差异）沿目标的现存祖先比较文件系统身份，
 * 不把包含判定弱化成文本近似。
 * @param path - 目标的 canonical 路径（可带尚不存在的尾部）。
 * @param root - canonical 可写根。
 * @param caseSensitive - 词法比较是否区分大小写；默认按宿主平台约定。
 * @returns 目标是该根或其后代时为 true。
 */
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
