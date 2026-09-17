import type { SessionEventLike } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";

export interface ConversationMatchResult {
  readonly id: string;
  readonly role: "start" | "update";
}

export interface ConversationTurnDataMap {}

export interface ConversationStepDataMap {}

export interface ConversationLocationDataSource<Value> {
  readonly getSnapshot: () => Value;

  readonly subscribe: (listener: () => void) => () => void;
}

export interface ConversationLocationDataStore<DataMap extends object> {
  get<Key extends keyof DataMap & string>(key: Key): Readonly<DataMap[Key]> | undefined;

  source<Key extends keyof DataMap & string>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<DataMap[Key]> | undefined>;
}

interface ConversationLocationDataValue {
  readonly kind: "turn" | "step";
  readonly turn: number;
  readonly step?: number;
  readonly key: string;
  readonly value: unknown;
}

type RegisteredTurnData<DataMap extends object> = {
  [Key in Extract<keyof DataMap, string>]: {
    readonly kind: "turn";
    readonly turn: number;
    readonly key: Key;
    readonly value: DataMap[Key];
  };
}[Extract<keyof DataMap, string>];

type RegisteredStepData<DataMap extends object> = {
  [Key in Extract<keyof DataMap, string>]: {
    readonly kind: "step";
    readonly turn: number;
    readonly step: number;
    readonly key: Key;
    readonly value: DataMap[Key];
  };
}[Extract<keyof DataMap, string>];

type ConversationLocationDataOf<TurnData extends object, StepData extends object> = [
  keyof TurnData | keyof StepData,
] extends [never]
  ? ConversationLocationDataValue
  : RegisteredTurnData<TurnData> | RegisteredStepData<StepData>;

export type ConversationLocationData = ConversationLocationDataOf<
  ConversationTurnDataMap,
  ConversationStepDataMap
>;

export interface StepLocation {
  readonly turn: number;
  readonly step: number;
  readonly start: SessionEvent<"step/start"> | undefined;
  readonly end: SessionEvent<"step/end"> | undefined;
  readonly status: "open" | "closed" | "unknown";

  readonly data: ConversationLocationDataStore<ConversationStepDataMap>;
}

export interface TurnLocation {
  readonly turn: number;
  readonly start: SessionEvent<"turn/start"> | undefined;
  readonly end: SessionEvent<"turn/end"> | undefined;
  readonly status: "open" | "closed" | "unknown";
  readonly steps: readonly StepLocation[];

  readonly data: ConversationLocationDataStore<ConversationTurnDataMap>;
}

export type ConversationLocation =
  | { readonly kind: "session" }
  | { readonly kind: "turn"; readonly turn: TurnLocation }
  | { readonly kind: "step"; readonly turn: TurnLocation; readonly step: StepLocation }
  | { readonly kind: "unresolved" };

interface ConversationMatchOf<
  Event extends SessionEventLike,
  Role extends ConversationMatchResult["role"],
> {
  readonly event: Event;
  readonly role: Role;
  readonly location: ConversationLocation;
}

export type ConversationStartMatch = ConversationMatchOf<SessionEvent, "start">;

export type ConversationMatch =
  | ConversationStartMatch
  | ConversationMatchOf<SessionEventLike, "update">;

export interface ConversationViewNode {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly target: string;
  readonly data: unknown;
}

export interface ConversationViewSnapshotMap {}

export interface ConversationViewSnapshotStore {
  get<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ConversationViewSnapshotMap[Target] | undefined;
}

export interface ConversationNodeContext<State = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly matches: readonly ConversationMatch[];
  readonly start: ConversationStartMatch | undefined;
  readonly state: State | undefined;
  readonly current: ReadonlyMap<string, ConversationViewNode | null>;
}

export interface ConversationPreviousContext<State = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly startSeq: number;
  readonly state: Readonly<State>;
  readonly matches: readonly ConversationMatch[];
}

export interface ConversationContextReader {
  previous<State>(kind: string): ConversationPreviousContext<State> | undefined;
}

export type ConversationPublication = "none" | "animation-frame" | "immediate";

export type ConversationLocationDataScope = "step" | "turn";

export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string;

  readonly target?: string;

  match(event: SessionEventLike): ConversationMatchResult | null;

  start(
    context: ConversationNodeContext<State>,
    match: ConversationStartMatch,
    reader: ConversationContextReader,
  ): State;

  update(
    context: ConversationNodeContext<State> & { readonly state: State },
    match: ConversationMatch,
  ): State;

  publication?(match: ConversationMatch): ConversationPublication;

  buildLocationData?(
    context: ConversationNodeContext<State>,
    scope: ConversationLocationDataScope,
    previous: ConversationLocationData | null,
  ): ConversationLocationData | null;

  buildViewNode?(context: ConversationNodeContext<State>): ConversationViewNode | null;
}

export interface ConversationTimelineSnapshot {
  readonly turnOrder: readonly number[];
  readonly turns: ReadonlyMap<number, TurnLocation>;
}

export interface ConversationViewBuilder<
  Node extends ConversationViewNode = ConversationViewNode,
  Snapshot = unknown,
> {
  readonly empty: Snapshot;

  replace(input: {
    readonly nodes: readonly Node[];
    readonly timeline: ConversationTimelineSnapshot;
  }): Snapshot;

  apply(input: {
    readonly upserts: readonly Node[];
    readonly timeline: ConversationTimelineSnapshot;
  }): Snapshot;
}

export interface ConversationViewDefinition<
  Node extends ConversationViewNode = ConversationViewNode,
  Snapshot = unknown,
> {
  readonly target: string;

  create(): ConversationViewBuilder<Node, Snapshot>;

  isActive?(snapshot: Snapshot): boolean;
}

export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`;
}
