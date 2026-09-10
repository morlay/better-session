import type { TableDef } from "../../adapters/types.ts";

export const sessions: TableDef = {
  name: "t_sessions",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_session_id: { type: "text", notNull: true, unique: true },
    f_head_event_id: { type: "text", notNull: true, default: "" },
    f_head_sequence: { type: "integer", notNull: true, default: -1 },
    f_version: { type: "integer", notNull: true },
    f_created_at: { type: "bigint", notNull: true },
    f_cwd: { type: "text" },
    f_parent_session: { type: "text" },
    f_seed_length: { type: "integer" },
    f_origin: { type: "text" },
    f_delegation_depth: { type: "integer" },
    f_incarnation: { type: "text", notNull: true },
    f_revision: { type: "integer", notNull: true },
    /** 归档标记：非空即该会话已归档（毫秒时间戳），NULL 表示未归档。 */
    f_archived_at: { type: "bigint" },
    /** 最新会话标题（最后一条 `session/title` 事件的 title），NULL 表示尚无标题。 */
    f_title: { type: "text" },
    /** `f_title` 来源事件的稠密 seq（列表 hint 的水位）。 */
    f_title_seq: { type: "integer" },
  },
};
