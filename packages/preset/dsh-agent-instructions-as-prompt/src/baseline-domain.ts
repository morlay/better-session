/**
 * Durable session baseline, kept in a `ctx.storageDomain` KV domain.
 *
 * The domain is host-side state: it never reaches the model-visible prompt and
 * never becomes a session event, so a restarted session restores the exact
 * sections it injected — and the incremental reconciliation keeps seeing the
 * baseline scopes — while the prompt text stays plain file content.
 *
 * A session event was not an option: `Session.append()` writes no `ignorable`
 * marker, and the persistence read path refuses an unrecognized event type
 * unless the stored envelope carries one. An out-of-repo plugin cannot register
 * a type, so its event would make the whole session unreadable after a restart.
 * @module @morlay/dsh-agent-instructions-as-prompt/baseline-domain
 */

import type { Context } from "@deepseek-ai/cordis";
import type { DomainFacility, KvTable } from "@deepseek-ai/dsh-storage-domain";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

const fileSchema = z.object({
  scope: z.string(),
  path: z.string(),
  digest: z.string(),
  content: z.string(),
});

const baselineSchema = z.object({
  identity: z.string(),
  files: z.array(fileSchema),
});

/** One persisted instruction file: scope, model-facing path, digest, section text. */
export type BaselineRecordFile = z.infer<typeof fileSchema>;

/** The baseline one session injected, as persisted. */
export type BaselineRecord = z.infer<typeof baselineSchema>;

/** The domain declaration; `defineDomain` validates it at module load. */
export const baselineDomain = defineDomain({
  name: "agent_instructions_as_prompt",
  version: 1,
  tables: { baselines: domainTable<string, BaselineRecord>(baselineSchema) },
});

/** One session's baseline table, keyed by session id. */
export type BaselineTable = KvTable<string, BaselineRecord>;

/**
 * Open the baseline domain and keep the handle for the plugin's lifetime.
 * @param ctx - plugin context.
 * @returns the table, or undefined when the facility is unmounted or refuses the domain.
 */
export async function openBaselineTable(ctx: Context): Promise<BaselineTable | undefined> {
  const facility = ctx.get("storageDomain") as DomainFacility | undefined;
  if (facility === undefined) return undefined;
  try {
    const domain = await facility.open(baselineDomain);
    ctx.effect(() => () => {
      void domain.close();
    });
    return domain.table("baselines");
  } catch (error) {
    // 存储域不可用（未挂载、或路由到的后端不支持 kv）：退回「每进程重读文件」。
    ctx.logger.warn("agent-instructions-as-prompt: baseline domain unavailable");
    ctx.logger.warn(error);
    return undefined;
  }
}
