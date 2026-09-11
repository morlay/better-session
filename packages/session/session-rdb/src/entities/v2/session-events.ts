import type { TableDef } from "../../adapters/types.ts";
import { sessionEvents as v3SessionEvents } from "../v3/session-events.ts";

/** v2 派生：v3 规格 + f_original_seq 列（原样存储前记录上游 seq 的遗留列）。 */
export const sessionEvents: TableDef = {
  ...v3SessionEvents,
  columns: {
    ...v3SessionEvents.columns,
    f_original_seq: { type: "integer", notNull: true },
  },
};
