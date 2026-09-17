import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { EventRow, SessionRow } from "./backend.ts";
import { repairRequestHeaders, rowToMeta, scanRows } from "./log.ts";

function physicalHeader(row: SessionRow): Record<string, unknown> {
  const common = {
    type: "session",
    version: row.fVersion,
    id: row.fSessionId,
    createdAt: row.fCreatedAt,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession } : {}),
    ...(row.fOrigin !== null ? { origin: row.fOrigin } : {}),
    delegationDepth: row.fDelegationDepth ?? 0,
  };

  return row.fVersion < 2
    ? { ...common, ...(row.fSeedLength !== null ? { seedLength: row.fSeedLength } : {}) }
    : { ...common, isSeeded: row.fSeedLength !== null };
}

function physicalEvent(row: EventRow): Record<string, unknown> {
  const stored = JSON.parse(row.fData) as unknown;

  const full =
    typeof stored === "object" &&
    stored !== null &&
    !Array.isArray(stored) &&
    typeof (stored as Record<string, unknown>)["type"] === "string" &&
    "data" in (stored as Record<string, unknown>);
  return {
    type: row.fType,
    seq: row.fSequence,
    time: row.fCreatedAt,
    data: full ? (stored as Record<string, unknown>)["data"] : stored,
    ...(row.fSurfaceOp !== null ? { surfaceOp: JSON.parse(row.fSurfaceOp) as unknown } : {}),
  };
}

export function convertLegacyRows(
  row: SessionRow,
  eventRows: readonly EventRow[],
): { meta: SessionHeader; inheritedEventCount: number; events: SessionEvent[] } {
  const restore = sessionFormatCatalog.createRestore(physicalHeader(row), {
    recovery: "strict",
    validation: "transformed",
  });
  for (const eventRow of eventRows) {
    restore.decodeRow(physicalEvent(eventRow));
  }
  const artifact = restore.finish();
  return {
    meta: artifact.header as unknown as SessionHeader,
    inheritedEventCount: artifact.inheritedEventCount,
    events: artifact.events as unknown as SessionEvent[],
  };
}

export function isLegacyVersion(version: number): boolean {
  return version < SESSION_FORMAT_VERSION;
}

export function adoptLegacyRows(
  row: SessionRow,
  eventRows: readonly EventRow[],
): {
  meta: SessionHeader;
  inheritedEventCount: number;
  events: SessionEvent[];
  tornFrom?: number;
} {
  const { preserved, tornFrom } = scanRows(eventRows, 0);

  repairRequestHeaders(preserved);
  return {
    meta: { ...rowToMeta(row), version: SESSION_FORMAT_VERSION },

    inheritedEventCount: Math.min(row.fSeedLength ?? 0, preserved.length),
    events: preserved,
    ...(tornFrom !== undefined ? { tornFrom } : {}),
  };
}

export type { SessionId };
