import type { Context as ClientContext } from "@deepseek-ai/cordis";
import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  ArbitrateKey,
  ArbitrateOutcome,
  PickOutcome,
  ReferenceInsert,
} from "@morlay/dsh-client-ui-conversation/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { detectTrigger } from "../core/detect.ts";
import { MENU_CLOSED, menuReduce, seedGroups } from "../core/menu.ts";
import type { MenuEvent, MenuState, TriggerHit } from "../core/contract.ts";
import type {
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerCrumb,
  InputTriggerSource,
  PickAction,
  SubmitEnvelope,
  TriggerChar,
  TriggerGuard,
} from "../types.ts";

export interface SourceRoster {
  sources(trigger: string): readonly InputTriggerSource[];
  all(): readonly InputTriggerSource[];
}

export interface InputTriggerControllerDeps {
  actx: ClientContext;

  sessionId: SessionId;

  roster: SourceRoster;
}

export class InputTriggerController {
  readonly menu: SnapshotStore<MenuState> = createSnapshotStore<MenuState>(MENU_CLOSED);

  readonly launcher: SnapshotStore<string | null> = createSnapshotStore<string | null>(null);

  readonly headers: SnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>> =
    createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(new Map());

  readonly lexicon: SnapshotStore<ReadonlyMap<TriggerChar, readonly string[]>> =
    createSnapshotStore<ReadonlyMap<TriggerChar, readonly string[]>>(new Map());

  private hit: TriggerHit | null = null;

  private drilled = false;
  private fetch: AbortController | null = null;
  private disposed = false;

  private readonly lexiconOffs = new Map<InputTriggerSource, () => void>();

  constructor(private readonly deps: InputTriggerControllerDeps) {
    const projection = this.project();
    for (const src of deps.roster.all()) {
      src.warm?.(projection);
      this.watchLexicon(src, projection);
    }
    this.refreshLexicon();
  }

  track(draft: string, caret: number, guard: TriggerGuard, draftRev: number): void {
    if (this.disposed) return;
    const launched = this.launcher.getSnapshot() !== null;
    this.clearLauncher();
    const raw = detectTrigger(draft, caret, guard);
    if (raw === null) {
      this.hit = null;
      this.stopFetch();
      this.reduce({ type: "close" });
      return;
    }
    const hit: TriggerHit = { ...raw, span: { ...raw.span, draftRev } };
    const prev = this.menu.getSnapshot();
    const same =
      !launched &&
      prev.open &&
      prev.hit !== null &&
      prev.hit.trigger === hit.trigger &&
      prev.hit.query === hit.query &&
      prev.hit.quoted === hit.quoted &&
      prev.hit.span.start === hit.span.start &&
      prev.hit.span.end === hit.span.end;
    this.hit = hit;
    if (same) return;
    const roster = this.deps.roster.sources(hit.trigger);
    if (roster.length === 0) {
      this.stopFetch();
      this.reduce({ type: "close" });
      return;
    }
    if (launched || !prev.open || prev.hit === null || prev.hit.trigger !== hit.trigger) {
      this.menu.set(seedGroups(this.menu.getSnapshot(), roster));
    }
    this.reduce({ type: "hit", hit });
    this.refreshHeaders(hit, roster);
    this.fetchCandidates(hit, roster);
  }

  toggleSource(source: string, hit: TriggerHit): void {
    if (this.disposed) return;
    if (this.launcher.getSnapshot() === source && this.menu.getSnapshot().open) {
      this.dismiss();
      return;
    }
    const match = this.deps.roster.sources(hit.trigger).find((item) => item.name === source);
    if (match === undefined) {
      this.dismiss();
      return;
    }
    this.stopFetch();
    this.hit = hit;
    this.launcher.set(source);
    this.menu.set(seedGroups(this.menu.getSnapshot(), [match]));
    this.reduce({ type: "hit", hit });
    this.refreshHeaders(hit, [match]);
    this.fetchCandidates(hit, [match]);
  }

  pick(source: string, index: number, action: PickAction = "pick"): void {
    const state = this.menu.getSnapshot();
    const hit = this.hit;
    if (this.disposed || !state.open || hit === null) return;
    const group = state.groups.find((g) => g.source === source);
    const candidate =
      group !== undefined && group.status === "ready" ? group.items[index] : undefined;
    if (candidate === undefined) return;
    const src = this.deps.roster.sources(hit.trigger).find((s) => s.name === source);
    if (src === undefined) return;
    this.settle(src, candidate, hit, action);
  }

  pickCrumb(source: string, index: number): void {
    const hit = this.hit;
    if (this.disposed || !this.menu.getSnapshot().open || hit === null) return;
    const crumb = this.headers.getSnapshot().get(source)?.[index];
    if (crumb === undefined || crumb.current === true) return;
    const src = this.deps.roster.sources(hit.trigger).find((s) => s.name === source);
    if (src === undefined) return;
    this.settle(src, { name: crumb.label, value: crumb.value }, hit, "drill");
  }

  hover(source: string, index: number): void {
    if (this.disposed) return;
    this.reduce({ type: "hover", source, index });
  }

  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    if (composing || this.disposed) return "pass";
    const state = this.menu.getSnapshot();
    if (!state.open) return "pass";
    switch (key) {
      case "up": {
        this.reduce({ type: "move", dir: -1 });
        return "consumed";
      }
      case "down": {
        this.reduce({ type: "move", dir: 1 });
        return "consumed";
      }
      case "escape": {
        this.stopFetch();
        this.reduce({ type: "close" });
        return "consumed";
      }
      case "enter": {
        if (state.highlight === null) return "pass";

        const group = state.groups.find((g) => g.source === state.highlight?.source);
        if (group === undefined || group.status !== "ready") return "consumed";
        this.pick(state.highlight.source, state.highlight.index);
        return "pick-highlighted";
      }
      case "tab": {
        if (state.highlight === null) return "pass";
        const group = state.groups.find((g) => g.source === state.highlight?.source);

        if (group === undefined || group.status !== "ready") return "consumed";
        const item = group.items[state.highlight.index];
        if (item === undefined) return "pass";
        if (item.drill === true) {
          this.pick(state.highlight.source, state.highlight.index, "drill");
          return "consumed";
        }
        this.pick(state.highlight.source, state.highlight.index);
        return "pick-highlighted";
      }
    }
  }

  onSpace(): boolean {
    const hit = this.hit;
    if (this.disposed || hit === null || hit.position !== "leading") return false;
    const token = hit.trigger + hit.query;
    const projection = this.project();
    for (const src of this.deps.roster.sources(hit.trigger)) {
      if (src.matchSpace === undefined) continue;
      const outcome = src.matchSpace(projection, token);
      if (outcome === undefined) continue;
      if (outcome === "handled") return true;
      return this.execute(outcome, hit.span);
    }
    return false;
  }

  serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string> {
    const owner = this.deps.roster.all().find((s) => s.name === source);
    if (owner?.codec === undefined) {
      return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`));
    }
    return owner.codec.serialize(ref, signal);
  }

  openReference(
    source: string | undefined,
    reference: Pick<ReferenceInsert, "ref" | "appearance">,
  ): boolean {
    if (this.disposed) return false;
    const session = this.project();
    for (const owner of this.deps.roster.all()) {
      const matches =
        source === undefined
          ? reference.ref.startsWith(owner.trigger) &&
            owner.lexicon?.(session)?.includes(reference.ref.slice(1))
          : owner.name === source;
      if (matches && owner.openReference?.(session, reference)) {
        this.dismiss();
        return true;
      }
    }
    return false;
  }

  async adjudicate(
    line: string,
    signal: AbortSignal,
    envelope: SubmitEnvelope,
  ): Promise<PickOutcome> {
    const projection = this.project();
    for (const src of this.deps.roster.all()) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("slash adjudication aborted");
      }
      if (src.matchEnter === undefined || !line.startsWith(src.trigger)) continue;
      const outcome = await src.matchEnter(projection, line, signal, envelope);
      if (outcome !== undefined) return outcome;
    }
    return undefined;
  }

  sourceRemoved(source: InputTriggerSource): void {
    const state = this.menu.getSnapshot();
    if (state.open && state.hit !== null && state.hit.trigger === source.trigger) {
      this.reduce({ type: "source-failed", generation: state.generation, source: source.name });
    }
    this.lexiconOffs.get(source)?.();
    this.lexiconOffs.delete(source);
    this.refreshLexicon();
  }

  sourceAdded(source: InputTriggerSource): void {
    const projection = this.project();
    source.warm?.(projection);
    this.watchLexicon(source, projection);
    this.refreshLexicon();
  }

  dismiss(): void {
    if (this.disposed) return;
    this.stopFetch();
    this.reduce({ type: "close" });
  }

  refreshOpenMenu(): void {
    if (this.disposed || !this.menu.getSnapshot().open || this.hit === null) return;
    const launched = this.launcher.getSnapshot();
    const roster = this.deps.roster
      .sources(this.hit.trigger)
      .filter((source) => launched === null || source.name === launched);
    if (roster.length === 0) return;
    this.fetchCandidates(this.hit, roster);
  }

  dispose(): void {
    this.disposed = true;
    this.stopFetch();
    this.reduce({ type: "close" });
    this.hit = null;
    for (const off of this.lexiconOffs.values()) off();
    this.lexiconOffs.clear();
  }

  private project(): ClientSessionContext {
    return { sessionId: this.deps.sessionId };
  }

  private execute(outcome: PickOutcome, span: import("../types.ts").TokenSpan): boolean {
    const { actx } = this.deps;
    if (outcome === undefined || outcome === "handled") return false;
    if ("claim" in outcome) {
      return actx.bail(actx, "slash/input-begin-command", { claim: outcome.claim, span }) === true;
    }
    if ("text" in outcome) {
      return (
        actx.bail(actx, "slash/input-insert-text", {
          text: outcome.text,
          span,
          ...(outcome.continue === true ? { continue: true } : {}),
        }) === true
      );
    }
    return (
      actx.bail(actx, "slash/input-insert-reference", { reference: outcome.insert, span }) === true
    );
  }

  private refreshLexicon(): void {
    const projection = this.project();
    const rolls = new Map<TriggerChar, readonly string[]>();
    for (const src of this.deps.roster.all()) {
      if (src.lexicon === undefined) continue;
      let names: readonly string[] | undefined;
      try {
        names = src.lexicon(projection);
      } catch (error) {
        console.error(`[ui-input-trigger] source "${src.name}" lexicon failed:`, error);
        continue;
      }
      if (names === undefined) continue;
      const prev = rolls.get(src.trigger);
      rolls.set(src.trigger, prev === undefined ? names : [...prev, ...names]);
    }
    this.lexicon.set(rolls);
  }

  private watchLexicon(source: InputTriggerSource, projection: ClientSessionContext): void {
    if (source.lexicon === undefined || source.subscribeLexicon === undefined) return;
    this.lexiconOffs.set(
      source,
      source.subscribeLexicon(projection, () => {
        this.refreshLexicon();
        const hit = this.hit;
        if (hit === null || !this.menu.getSnapshot().open || hit.trigger !== source.trigger) return;

        void Promise.resolve().then(() => {
          if (this.disposed || this.hit !== hit || !this.menu.getSnapshot().open) return;
          this.fetchCandidates(hit, this.deps.roster.sources(hit.trigger));
        });
      }),
    );
  }

  private fetchCandidates(hit: TriggerHit, roster: readonly InputTriggerSource[]): void {
    this.stopFetch();
    const controller = new AbortController();
    this.fetch = controller;
    const generation = this.menu.getSnapshot().generation;
    const projection = this.project();
    for (const source of roster) {
      void source
        .candidates(projection, {
          query: hit.query,
          quoted: hit.quoted,
          position: hit.position,
          drilled: this.drilled,
          signal: controller.signal,
        })
        .then(
          (items) => {
            if (controller.signal.aborted) return;
            this.reduce({ type: "source-settled", generation, source: source.name, items });
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            console.error(`[ui-input-trigger] source "${source.name}" candidates failed:`, error);
            this.reduce({ type: "source-failed", generation, source: source.name });
          },
        );
    }
  }

  private stopFetch(): void {
    this.fetch?.abort();
    this.fetch = null;
  }

  private settle(
    src: InputTriggerSource,
    candidate: InputTriggerCandidate,
    hit: TriggerHit,
    action: PickAction,
  ): void {
    const outcome = src.onPick({
      candidate,
      session: this.project(),
      position: hit.position,
      via: "menu",
      action,
      span: hit.span,
    });
    this.stopFetch();
    this.reduce({ type: "close" });

    this.drilled = action === "drill";
    if (!this.execute(outcome, hit.span)) this.drilled = false;
  }

  private refreshHeaders(hit: TriggerHit, roster: readonly InputTriggerSource[]): void {
    const projection = this.project();
    const crumbs = new Map<string, readonly InputTriggerCrumb[]>();
    for (const src of roster) {
      if (src.header === undefined) continue;
      let published: readonly InputTriggerCrumb[] | undefined;
      try {
        published = src.header(projection, {
          query: hit.query,
          quoted: hit.quoted,
          drilled: this.drilled,
        });
      } catch (error) {
        console.error(`[ui-input-trigger] source "${src.name}" header failed:`, error);
        continue;
      }
      if (published === undefined || published.length === 0) continue;
      crumbs.set(src.name, published);
    }
    this.setHeaders(crumbs);
  }

  private setHeaders(next: ReadonlyMap<string, readonly InputTriggerCrumb[]>): void {
    if (this.headers.getSnapshot().size === 0 && next.size === 0) return;
    this.headers.set(next);
  }

  private clearLauncher(): void {
    if (this.launcher.getSnapshot() !== null) this.launcher.set(null);
  }

  private reduce(ev: MenuEvent): void {
    const cur = this.menu.getSnapshot();
    const next = menuReduce(cur, ev);
    if (next !== cur) this.menu.set(next);
    if (next.open) return;
    this.clearLauncher();
    this.drilled = false;
    this.setHeaders(new Map());
  }
}
