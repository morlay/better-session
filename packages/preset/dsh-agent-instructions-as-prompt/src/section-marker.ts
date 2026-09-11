/**
 * Baseline instruction sections carried inside the system prompt.
 *
 * Each retained instruction file becomes one section whose head line is a JSON
 * comment holding the discovery identity plus the scope, model-facing path, and
 * content digest the incremental reconciliation compares against. The marker
 * travels with the rendered prompt (surface node 0), so a resumed session
 * rebuilds both the frozen section text and the visible instruction state
 * without re-reading the files.
 * @module @morlay/dsh-agent-instructions-as-prompt/section-marker
 */

import type { Session } from "@deepseek-ai/dsh-session";

/** Metadata one section head carries. */
export interface BaselineSectionMeta {
  /** Discovery/precedence/budget identity of the baseline this section belongs to. */
  identity: string;
  /** Logical instruction scope (see `instructionScopeKey`). */
  scope: string;
  /** Model-facing path shown to the model. */
  path: string;
  /** Content digest used by the incremental reconciliation. */
  digest: string;
}

/** One decoded section: its metadata and the instruction text that follows. */
export interface BaselineSection extends BaselineSectionMeta {
  text: string;
}

const MARKER_PATTERN = /<!-- workspace-instructions (\{.*?\}) -->\n?/gu;

/** Render one section: a metadata head line followed by the instruction text. */
export function encodeBaselineSection(meta: BaselineSectionMeta, text: string): string {
  return `<!-- workspace-instructions ${JSON.stringify(meta)} -->\n${text}`;
}

/**
 * Decode every section this plugin wrote into a rendered prompt.
 * @param prompt - full system prompt text.
 * @returns sections in prompt order; empty when the plugin wrote none.
 */
export function decodeBaselineSections(prompt: string): BaselineSection[] {
  const marks: { meta: BaselineSectionMeta; start: number; end: number }[] = [];
  for (const match of prompt.matchAll(MARKER_PATTERN)) {
    const body = match[1];
    if (body === undefined) continue;
    try {
      const meta = JSON.parse(body) as BaselineSectionMeta;
      if (typeof meta.identity !== "string" || typeof meta.scope !== "string") continue;
      if (typeof meta.path !== "string" || typeof meta.digest !== "string") continue;
      marks.push({ meta, start: match.index, end: match.index + match[0].length });
    } catch {
      continue; // A foreign comment that merely resembles the marker.
    }
  }
  return marks.map((mark, index) => ({
    ...mark.meta,
    text: prompt.slice(mark.end, marks[index + 1]?.start).trimEnd(),
  }));
}

/**
 * The effective system prompt of a session: the newest surviving non-empty
 * `system/message` node (the same node the loop's projection reconciles).
 * @param session - session whose surface holds the prompt.
 * @returns the prompt text, or `''` when the session has none.
 */
export function systemPromptText(session: Session): string {
  const surface = new Set(session.surface.nodes);
  for (const event of session.snapshotEvents().toReversed()) {
    if (event.type !== "system/message" || !surface.has(event.seq)) continue;
    const content = event.data.message.content;
    const block = content.length === 1 ? content[0] : undefined;
    if (block?.type === "text" && block.text !== "") return block.text;
  }
  return "";
}
