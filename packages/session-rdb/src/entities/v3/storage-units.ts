import type { TableDef } from "../../adapters/types.ts";

/** storage 域版本账本：域首次打开时写入 descriptor version，其后按 accepted 集合校验。 */
export const storageUnits: TableDef = {
  name: "t_storage_units",
  columns: {
    f_name: { type: "text", primaryKey: true },
    f_version: { type: "integer", notNull: true },
  },
};
