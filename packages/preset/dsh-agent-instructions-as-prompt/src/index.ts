/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful fs
 * tool touches project nested, changed, and removed instructions into the inbox.
 * Plugin lifecycle reads use the optional `ctx.fs` provider, so providerless products
 * mount it as a no-op.
 *
 * Copied from `@deepseek-ai/dsh-agent-instructions@0.1.5-rc.2` (upstream
 * `packages/context/agent-instructions/src/index.ts`). Local changes: the
 * baseline is delivered as system-prompt sections (`./prompt.ts`) instead of a
 * user-role reminder, and its visible state is read back from the prompt
 * markers; every mid-session path (tool touches, inbox reconciliation, pre-step
 * fold) is unchanged.
 *
 * @module @morlay/dsh-agent-instructions-as-prompt
 */

import type { Context } from "@deepseek-ai/cordis";
import { isDeepStrictEqual } from "node:util";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, UserMessage } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {
  ToolExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from "@deepseek-ai/dsh-tools";
import { Config, resolveConfig, workspaceBaselineIdentity, type ResolvedConfig } from "./config.ts";
import { findProjectRoot, loadBaselineInstructionSet } from "./files.ts";
import { applyPromptSections, promptBaselines, promptInstructionFiles } from "./prompt.ts";
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  name,
  reconcileInstructionContext,
  type InstructionVersionCache,
  type AgentInstructionSource,
} from "./state.ts";
import type { AgentInstructionChange } from "./render.ts";

export { Config, name };
/**
 * Services required by workspace instruction projection.
 *
 * `systemPrompt` is deliberately not declared: the section injection is an event
 * listener, and this plugin also mounts inside a preset's per-session agent
 * composition, where a strict injection on a host-level service would keep the
 * whole plugin (including mid-session reconciliation) from loading.
 */
export const inject = ["sessionProjections"];
export { discoverBaselineInstructionFiles, loadBaselineInstructions } from "./files.ts";
export type { InstructionFile, LoadedInstructionFile } from "./files.ts";
export { renderWorkspaceContext } from "./render.ts";
export type { RenderedWorkspaceContext, TruncatedInstruction } from "./render.ts";

/**
 * The baseline this session already carries: the snapshot this plugin injected
 * into the system prompt.
 * @param agent - session owner.
 * @returns the baseline source, or undefined when nothing was injected.
 */
function visibleBaselineSource(agent: Agent): AgentInstructionSource | undefined {
  const snapshot = promptBaselines.get(agent.session);
  if (snapshot === undefined) return undefined;
  return {
    kind: "agent-instructions",
    form: "instructions",
    baseline: true,
    baselineIdentity: snapshot.identity,
    changes: [...baselineInstructionState(snapshot.files).changes.values()],
  };
}

function isWorkspaceContext(message: UserMessage): boolean {
  return message.source.kind === "agent-instructions";
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return (
    isDeepStrictEqual(left.content, right.content) && isDeepStrictEqual(left.source, right.source)
  );
}

const FILE_TOUCH_TOOL_NAMES = new Set(["read", "write", "edit"]);

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined;
  if (typeof exec.arguments !== "object" || exec.arguments === null) return undefined;
  if (!("file_path" in exec.arguments) || typeof exec.arguments.file_path !== "string")
    return undefined;
  const filePath = exec.arguments.file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config);
  const instructionVersions: InstructionVersionCache = new WeakMap();
  const baselinePreparations = new WeakMap<
    Session,
    {
      identity: string;
      excludedScopes: ReadonlySet<string>;
    }
  >();
  const projectionLifecycle = new AbortController();
  type ProjectionTouch = { agent: Agent; path: string };
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>();
  ctx.effect(
    () => () => {
      projectionLifecycle.abort(new Error("agent-instructions disposed"));
      executionTouches.clear();
    },
    "agent-instructions.projectionLifecycle",
  );
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>();
  // Execution ancestry and the enclosing durable step are the two commit
  // boundaries before an asynchronous projection may mutate the agent inbox.
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>();

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted();
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return undefined;
    }
    const fileSystem = ctx.get("fs");
    if (fileSystem === undefined) return undefined;
    if (touchedPaths.length === 0 && pending.length > 0) return pending[0];
    const content: UserMessage["content"][number][] = [];
    const changes: AgentInstructionChange[] = [];
    const authorityMessages = [...claimed];
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd();
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal);
    const identity = workspaceBaselineIdentity(resolved, cwd, projectRoot);
    const visibleBaseline = visibleBaselineSource(agent);
    const baselinePresent = visibleBaseline !== undefined;
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity;
    const prepared = baselinePreparations.get(agent.session);
    let excludedBaselineScopes =
      keepVisibleBaseline && prepared?.identity === identity ? prepared.excludedScopes : undefined;
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined;
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline;
      const instructions = await loadBaselineInstructionSet(
        {
          cwd,
          dshHome: resolved.dshHome,
          projectRootMarkers: resolved.projectRootMarkers,
          maxBytes: resolved.maxBytes,
          maxSourceBytes: resolved.maxSourceBytes,
          instructionFileCandidates: resolved.instructionFileCandidates,
          localInstructionFileCandidates: resolved.localInstructionFileCandidates,
          projectRoot,
          replacePreviousBaseline,
          signal,
        },
        fileSystem,
      );
      // 只有进 system prompt 的那两个 scope 算「已提供」；其余候选（嵌套目录、
      // 被预算裁掉的）落进 excludedScopes，等工具触达时再走提醒通道。
      const promptFiles = promptInstructionFiles(instructions?.included ?? []);
      const baseline = baselineInstructionState(promptFiles);
      // 与 system prompt 注入共用同一份快照：谁先加载谁写入，后到者复用。
      promptBaselines.set(agent.session, { identity, files: promptFiles });
      const observedBaseline = baselineInstructionState(instructions?.observed ?? []);
      const excludedScopes = new Set(observedBaseline.changes.keys());
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope);
      excludedBaselineScopes = excludedScopes;
      nextPreparation = { identity, excludedScopes };
      let versionStates = instructionVersions.get(agent.session);
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map();
        instructionVersions.set(agent.session, versionStates);
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state);
      // The baseline itself is not injected here: it travels as system-prompt
      // sections (`./prompt.ts`). What this pass keeps is the accounting the
      // later deltas need — the excluded scopes and the provider versions.
    }
    const update = await reconcileInstructionContext(
      agent,
      resolved,
      instructionVersions,
      fileSystem,
      {
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...(keepVisibleBaseline ? { excludedBaselineScopes } : {}),
        touchedPaths,
        projectRoot,
        signal,
      },
    );
    if (update !== undefined) {
      content.push(...update.context.content);
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === "agent-instructions") {
        changes.push(...update.context.source.changes);
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions);
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation);
    if (content.length === 0) return undefined;
    return createUserMessage({
      content,
      source: {
        kind: "agent-instructions",
        form: "instructions",
        changes,
      },
    });
  };

  const syncInbox = (
    agent: Agent,
    claimed: readonly UserMessage[],
    desired: UserMessage | undefined,
  ): void => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext);
    const alreadySupplied =
      desired !== undefined &&
      (claimed.some((message) => sameContextPayload(message, desired)) ||
        agent.session.surface.nodes.some((seq) => {
          const event = agent.session.eventAt(seq);
          return event?.type === "user/message" && sameContextPayload(event.data, desired);
        }));
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id);
      return;
    }
    const reusable = pending.find((message) => sameContextPayload(message, desired));
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id);
      }
      return;
    }
    const replaced = pending[0];
    if (replaced === undefined) agent.inbox.prepend("next-step", desired);
    else agent.inbox.replace(replaced.id, desired);
    for (const message of pending.slice(1)) agent.inbox.remove(message.id);
  };

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext);
    const desired = await compose(agent, signal, claimed, pending, touchedPaths);
    signal.throwIfAborted();
    syncInbox(agent, claimed, desired);
  };

  const queueProjection = (agent: Agent, touchedPath: string): void => {
    const previous = projectionTails.get(agent) ?? Promise.resolve();
    const current = previous
      .then(() => composeAndSync(agent, projectionLifecycle.signal, [], [touchedPath]))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted)
          ctx.logger.warn("workspace instruction refresh failed: %o", error);
      });
    projectionTails.set(agent, current);
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent);
    });
  };

  const waitForProjections = async (agent: Agent): Promise<void> => {
    let projection: Promise<void> | undefined;
    while ((projection = projectionTails.get(agent)) !== undefined) await projection;
  };

  const stepIsOpen = (session: Session): boolean => {
    const boundary = ctx.sessionProjections.stateOf(session, "turnBoundary");
    if (boundary === undefined) {
      throw new Error("agent-instructions requires the turnBoundary session projection");
    }
    return (
      boundary.openTurnStartSeq !== null &&
      boundary.lastStepBoundary?.kind === "start" &&
      boundary.lastStepBoundary.seq > boundary.openTurnStartSeq
    );
  };

  const projectTouch = (touch: ProjectionTouch): void => {
    const session = touch.agent.session;
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path);
      return;
    }
    const pending = stepTouches.get(session);
    if (pending === undefined) stepTouches.set(session, [touch]);
    else pending.push(touch);
  };

  ctx.on("session/event", (session, event) => {
    if (event.type !== "step/end") return;
    const pending = stepTouches.get(session);
    if (pending === undefined) return;
    stepTouches.delete(session);
    for (const touch of pending) queueProjection(touch.agent, touch.path);
  });

  ctx.on(
    "agent/pre-step",
    async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next();
      await waitForProjections(agent);
      const pending = agent.inbox.nextStep.filter(isWorkspaceContext);
      const desired = await compose(agent, signal, messages, pending);
      signal.throwIfAborted();
      // An empty first entry owns a no-step turn; keep context pending instead
      // of turning it into a standalone request. Later entries may be tool continuations.
      if (decision.kind === "reject" || (step === 1 && decision.messages.length === 0)) {
        syncInbox(agent, messages, desired);
        return decision;
      }
      // A proceeding step settles the pending context: it either enters below as
      // `desired`, or its payload is already covered by the batch, so nothing stays pending.
      for (const message of pending) agent.inbox.remove(message.id);
      if (
        desired === undefined ||
        decision.messages.some((message) => sameContextPayload(message, desired))
      ) {
        return decision;
      }
      // Fold the context right after the claimed batch, so the direct prompt
      // precedes it and the driver-appended runtime context follows it.
      const lastClaimedIndex = decision.messages.findLastIndex((message) =>
        messages.includes(message),
      );
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
      return { ...decision, messages: entered };
    },
  );

  ctx.on("tools/result", (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? [];
    executionTouches.delete(exec.token);
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec);
      if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath });
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent);
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches);
        else parentTouches.push(...touches);
      }
      return;
    }
    for (const touch of touches) projectTouch(touch);
  });

  // The baseline lands in the system prompt instead of the conversation: one
  // section per retained file, appended last (see ./prompt.ts).
  applyPromptSections(ctx, resolved);
}
