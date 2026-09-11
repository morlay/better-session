/**
 * Workspace instruction sections for the system prompt.
 *
 * Only the user-global and project-root instruction files become sections — the
 * two scopes that describe the workspace as a whole; nested files keep reaching
 * the model through the upstream mid-session reminder path. Each section is the
 * file content verbatim behind a metadata comment (see `./section-marker.ts`),
 * appended after the sections the assembly already carries so instructions read
 * last. The text is frozen per session: once the prompt carries the marker,
 * later assemblies rebuild the same sections from it instead of re-reading
 * files, which keeps surface node 0 (and the provider's KV-cache prefix) stable.
 * @module @morlay/dsh-agent-instructions-as-prompt/prompt
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import type { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { workspaceBaselineIdentity, type ResolvedConfig } from "./config.ts";
import { instructionContentSha1 } from "./digest.ts";
import {
  findProjectRoot,
  loadBaselineInstructionSet,
  type LoadedInstructionFile,
} from "./files.ts";
import { decodeScopeKey, instructionScopeKey, USER_GLOBAL_DIRECTORY } from "./render.ts";
import {
  decodeBaselineSections,
  encodeBaselineSection,
  systemPromptText,
  type BaselineSectionMeta,
} from "./section-marker.ts";

/** Section name prefix; one section per prompt-scope instruction file. */
export const SECTION_NAME_PREFIX = "workspace:instructions";

/** The project-root scope key directory (`relativeScope(root, root)`). */
const PROJECT_ROOT_DIRECTORY = ".";

const ZERO_WIDTH_SPACE = "\u200b";

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

function sectionEntry(
  meta: BaselineSectionMeta,
  text: string,
  index: number,
): { name: string; text: string } {
  return {
    name: `${SECTION_NAME_PREFIX}:${String(index)}`,
    text: escapeVariableReferences(encodeBaselineSection(meta, text)),
  };
}

/** Append sections after every existing one: workspace instructions read last. */
function appendSections(
  assembly: PromptAssembly,
  entries: readonly { name: string; text: string }[],
): PromptAssembly {
  return { ...assembly, sections: [...assembly.sections, ...entries] };
}

/** Discovery identity of the baseline this session's workspace implies. */
async function baselineIdentity(
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
 * Mount the system-prompt half of the plugin.
 * @param ctx - plugin context (needs the optional `fs` provider).
 * @param resolved - normalized plugin configuration.
 */
export function applyPromptSections(ctx: Context, resolved: ResolvedConfig): void {
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const resolvedAssembly = await next();
    // 同一 assembly 里已经有人注入过（profile 级与 preset 级可能各挂一个实例）：
    // 后到的实例让位，避免同一份指令出现两次。
    if (resolvedAssembly.sections.some((section) => section.name.startsWith(SECTION_NAME_PREFIX))) {
      return resolvedAssembly;
    }
    const agent = (context as AssembleContext & { agent?: Agent }).agent;
    const session = agent?.session;
    const fileSystem = ctx.get("fs");
    if (session === undefined || fileSystem === undefined) return resolvedAssembly;
    const cwd = session.header.cwd ?? process.cwd();
    try {
      const { identity, projectRoot } = await baselineIdentity(
        resolved,
        cwd,
        fileSystem,
        context.signal,
      );
      const existing = decodeBaselineSections(systemPromptText(session));
      if (existing.length > 0 && existing[0]?.identity === identity) {
        return appendSections(
          resolvedAssembly,
          existing.map((section, index) => sectionEntry(section, section.text, index)),
        );
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
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        fileSystem,
      );
      if (loaded === undefined) return resolvedAssembly;
      const files = promptInstructionFiles(loaded.included);
      if (files.length === 0) return resolvedAssembly;
      return appendSections(
        resolvedAssembly,
        files.map((file, index) =>
          sectionEntry(
            {
              identity,
              scope: instructionScopeKey(file.displayPath),
              path: file.displayPath,
              digest: instructionContentSha1(file.content),
            },
            file.content,
            index,
          ),
        ),
      );
    } catch (error) {
      // 读盘失败不应让整轮请求失败：保持 system prompt 不变，下一轮重试。
      ctx.logger.warn("agent-instructions-as-prompt: workspace instruction section failed");
      ctx.logger.warn(error);
      return resolvedAssembly;
    }
  });
}
