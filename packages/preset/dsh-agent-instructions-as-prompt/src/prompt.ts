/**
 * Workspace instruction sections for the system prompt.
 *
 * Only the user-global and project-root instruction files become sections — the
 * two scopes that describe the workspace as a whole; nested files keep reaching
 * the model through the upstream mid-session reminder path. Each section is the
 * file content verbatim, appended after the sections the assembly already
 * carries so instructions read last.
 *
 * The prompt text carries no metadata of its own. What this plugin injected is
 * remembered per session in {@link promptBaselines} (process-local) and in the
 * `ctx.storageDomain` baseline domain (durable, keyed by session id), so a
 * restarted session rebuilds the same sections instead of re-reading files that
 * may have changed meanwhile.
 * @module @morlay/dsh-agent-instructions-as-prompt/prompt
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import type { Session } from "@deepseek-ai/dsh-session";
import type { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { workspaceBaselineIdentity, type ResolvedConfig } from "./config.ts";
import { instructionContentSha1 } from "./digest.ts";
import {
  findProjectRoot,
  loadBaselineInstructionSet,
  type LoadedInstructionFile,
} from "./files.ts";
import { decodeScopeKey, instructionScopeKey, USER_GLOBAL_DIRECTORY } from "./render.ts";
import { type BaselineRecordFile, type BaselineTable } from "./baseline-domain.ts";
import { openBaselineTable } from "./baseline-domain.ts";

/** Section name prefix; one section per prompt-scope instruction file. */
export const SECTION_NAME_PREFIX = "workspace:instructions";

/** The project-root scope key directory (`relativeScope(root, root)`). */
const PROJECT_ROOT_DIRECTORY = ".";

const ZERO_WIDTH_SPACE = "\u200b";

/** The baseline one session carries in its system prompt. */
export interface PromptBaseline {
  /** Discovery/precedence/budget identity the snapshot was loaded under. */
  identity: string;
  /** Files that became sections, in prompt order. */
  files: LoadedInstructionFile[];
}

/**
 * Session-isolated snapshot of what this plugin put into the system prompt.
 * Shared by the injection, the incremental reconciliation (visible baseline
 * state), and the pre-step accounting, so all three agree on one load.
 */
export const promptBaselines = new WeakMap<Session, PromptBaseline>();

/**
 * Whether one instruction scope belongs in the system prompt: the user-global
 * file and the project root's, never a nested directory's.
 * @param scope - per-candidate scope key.
 * @returns whether the scope is a prompt scope.
 */
export function isPromptScope(scope: string): boolean {
  const { directory } = decodeScopeKey(scope);
  return directory === USER_GLOBAL_DIRECTORY || directory === PROJECT_ROOT_DIRECTORY;
}

/** The baseline files that become sections, in discovery order. */
export function promptInstructionFiles(
  files: readonly LoadedInstructionFile[],
): LoadedInstructionFile[] {
  return files.filter((file) => isPromptScope(instructionScopeKey(file.displayPath)));
}

/**
 * Break `{{` apart in instruction prose: `renderPrompt` interpolates every
 * `{{name}}` reference strictly and throws on an unregistered name, so a
 * workspace file that happens to contain one would otherwise fail the request.
 * The substituted character is invisible to the model.
 */
export function escapeVariableReferences(text: string): string {
  return text.replaceAll("{{", `{${ZERO_WIDTH_SPACE}{`);
}

/** Discovery identity of the baseline this session's workspace implies. */
export async function baselineIdentity(
  resolved: ResolvedConfig,
  cwd: string,
  fileSystem: FileSystem,
  signal: AbortSignal | undefined,
): Promise<{ identity: string; projectRoot: string }> {
  const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal);
  return {
    identity: workspaceBaselineIdentity(resolved, cwd, projectRoot),
    projectRoot,
  };
}

/**
 * The session's prompt baseline: the process-local snapshot, else the persisted
 * one for this identity, else a fresh load from the files (which is then
 * persisted, so a restart rebuilds the same sections).
 * @param ctx - plugin context (the optional `fs` provider).
 * @param resolved - normalized plugin configuration.
 * @param session - session whose prompt receives the sections.
 * @param signal - cancellation for the file reads.
 * @param table - persisted baseline table, when the storage domain is available.
 * @returns the snapshot, or undefined when nothing can be loaded.
 */
export async function loadPromptBaseline(
  ctx: Context,
  resolved: ResolvedConfig,
  session: Session,
  signal: AbortSignal | undefined,
  table?: BaselineTable,
): Promise<PromptBaseline | undefined> {
  const fileSystem = ctx.get("fs");
  if (fileSystem === undefined) return undefined;
  const cwd = session.header.cwd ?? process.cwd();
  const { identity, projectRoot } = await baselineIdentity(resolved, cwd, fileSystem, signal);
  const cached = promptBaselines.get(session);
  if (cached !== undefined && cached.identity === identity) return cached;
  const stored = table?.get(String(session.id));
  if (stored !== undefined && stored.identity === identity) {
    const restored: PromptBaseline = { identity, files: stored.files.map(toLoadedFile) };
    promptBaselines.set(session, restored);
    return restored;
  }
  const loaded = await loadBaselineInstructionSet(
    {
      cwd,
      projectRoot,
      dshHome: resolved.dshHome,
      projectRootMarkers: resolved.projectRootMarkers,
      maxBytes: resolved.maxBytes,
      maxSourceBytes: resolved.maxSourceBytes,
      instructionFileCandidates: resolved.instructionFileCandidates,
      localInstructionFileCandidates: resolved.localInstructionFileCandidates,
      ...(signal === undefined ? {} : { signal }),
    },
    fileSystem,
  );
  if (loaded === undefined) return undefined;
  const files = promptInstructionFiles(loaded.included);
  const snapshot: PromptBaseline = { identity, files };
  promptBaselines.set(session, snapshot);
  if (table !== undefined) {
    try {
      await table.put(String(session.id), { identity, files: files.map(toRecordFile) });
    } catch (error) {
      // 写失败只影响「重启后逐字一致」这一保证：本轮仍用内存快照。
      ctx.logger.warn("agent-instructions-as-prompt: baseline snapshot write failed");
      ctx.logger.warn(error);
    }
  }
  return snapshot;
}

/** One persisted file back in memory; the absolute path is display-derived. */
function toLoadedFile(file: BaselineRecordFile): LoadedInstructionFile {
  return { absolutePath: file.path, displayPath: file.path, content: file.content };
}

/** One loaded file in its persisted form. */
function toRecordFile(file: LoadedInstructionFile): BaselineRecordFile {
  return {
    scope: instructionScopeKey(file.displayPath),
    path: file.displayPath,
    digest: instructionContentSha1(file.content),
    content: file.content,
  };
}

/** One assembled section: content verbatim behind a numbered name. */
function sectionEntry(text: string, index: number): { name: string; text: string } {
  return {
    name: `${SECTION_NAME_PREFIX}:${String(index)}`,
    text: escapeVariableReferences(text),
  };
}

/** Append sections after every existing one: workspace instructions read last. */
function appendSections(
  assembly: PromptAssembly,
  entries: readonly { name: string; text: string }[],
): PromptAssembly {
  return { ...assembly, sections: [...assembly.sections, ...entries] };
}

/**
 * Mount the system-prompt half of the plugin.
 * @param ctx - plugin context (needs the optional `fs` provider).
 * @param resolved - normalized plugin configuration.
 */
export function applyPromptSections(ctx: Context, resolved: ResolvedConfig): void {
  // 存储域可能比本插件晚就绪（它等的是 backend 服务），所以在首次装配时才打开；
  // 打不开就退回「每进程重读文件」，不每轮重试刷日志。
  let table: BaselineTable | undefined;
  let opened = false;
  const tableOf = async (): Promise<BaselineTable | undefined> => {
    if (opened) return table;
    opened = true;
    table = await openBaselineTable(ctx);
    return table;
  };
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const resolvedAssembly = await next();
    // 同一 assembly 里已经有人注入过（profile 级与 preset 级可能各挂一个实例）：
    // 后到的实例让位，避免同一份指令出现两次。
    if (resolvedAssembly.sections.some((section) => section.name.startsWith(SECTION_NAME_PREFIX))) {
      return resolvedAssembly;
    }
    const agent = (context as AssembleContext & { agent?: Agent }).agent;
    const session = agent?.session;
    if (session === undefined) return resolvedAssembly;
    try {
      const baseline = await loadPromptBaseline(
        ctx,
        resolved,
        session,
        context.signal,
        await tableOf(),
      );
      if (baseline === undefined || baseline.files.length === 0) return resolvedAssembly;
      return appendSections(
        resolvedAssembly,
        baseline.files.map((file, index) => sectionEntry(file.content, index)),
      );
    } catch (error) {
      // 读盘失败不应让整轮请求失败：保持 system prompt 不变，下一轮重试。
      ctx.logger.warn("agent-instructions-as-prompt: workspace instruction section failed");
      ctx.logger.warn(error);
      return resolvedAssembly;
    }
  });
}
