import type { TableDef } from "../../adapters/types.ts";
import { sessionEvents as v3SessionEvents } from "../v3/session-events.ts";

export const sessionEvents: TableDef = {
  ...v3SessionEvents,
  columns: {
    ...v3SessionEvents.columns,
    f_original_seq: { type: "integer", notNull: true },
  },
};
