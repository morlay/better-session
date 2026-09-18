import type { Context } from "@deepseek-ai/cordis";
import type { SessionPersistenceRdb } from "./index.ts";

export const SESSION_USAGE_PATH = "/api/session.usage";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 时间范围的语义键：`all` 不限；`day` / `week` 是**本地自然日 / 自然周**（周一起算）；
 * `7d` / `30d` / `90d` 是最近 N 天（滚动窗口）。
 */
export type UsageRangeKey = "all" | "day" | "week" | "7d" | "30d" | "90d";

const ROLLING_DAYS: Record<"7d" | "30d" | "90d", number> = { "7d": 7, "30d": 30, "90d": 90 };

function localDayStart(now: number): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * 范围起点（含），不限时为 undefined。自然日 / 自然周按 host 的本地时区算，周边界是周一 00:00。
 * @param range - 语义键。
 * @param now - 当前时刻。
 * @returns 起点毫秒时间戳，或 undefined。
 */
export function resolveUsageSince(range: UsageRangeKey, now: number): number | undefined {
  switch (range) {
    case "all":
      return undefined;
    case "day":
      return localDayStart(now).getTime();
    case "week": {
      const start = localDayStart(now);
      // getDay(): 0 = 周日；换算成「距离本周一几天」。
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      return start.getTime();
    }
    default:
      return now - ROLLING_DAYS[range] * DAY_MS;
  }
}

function parseUsageRange(value: unknown): UsageRangeKey {
  return value === "day" || value === "week" || value === "7d" || value === "30d" || value === "90d"
    ? value
    : "all";
}

/** 一段用量合计（token 字段直接取事件里模型报的 usage）。 */
export interface UsageTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** 一天 × 一个模型 × 是否子代理 的用量桶：总览、按天、按模型都由它折叠。 */
export interface UsageBucket extends UsageTotals {
  day: string;
  provider: string | null;
  model: string | null;
  subagent: boolean;
}

/** 一条会话的用量行。 */
export interface UsageSessionRow extends UsageTotals {
  sessionId: string;
  title: string | null;
  subagent: boolean;
  archived: boolean;
}

/** 后端的原始聚合结果。 */
export interface UsageAggregate {
  buckets: UsageBucket[];
  sessions: UsageSessionRow[];
}

/** 一次统计请求的完整回报。 */
export interface SessionUsageReport {
  totals: UsageTotals;
  subagent: UsageTotals;
  /** 只被人类会话引用的部分（`totals − subagent`）。 */
  human: UsageTotals;
  buckets: UsageBucket[];
  sessions: UsageSessionRow[];
}

function emptyTotals(): UsageTotals {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

/** 折叠一组行（桶或会话行）的用量。 */
export function sumUsage(rows: readonly UsageTotals[]): UsageTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.events += row.events;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.reasoningTokens += row.reasoningTokens;
    totals.totalTokens += row.totalTokens;
  }
  return totals;
}

/**
 * 用量统计通道：一次请求回报总览（含 subagent 拆分）、按天 × 模型的桶与按会话的行。
 * 聚合只算被会话引用的事件行——fork 共享行因此只计一次，已删会话留下的孤儿行不计。
 */
export function registerSessionUsage(ctx: Context, persistence: SessionPersistenceRdb): void {
  ctx.inject(["webServer", "connection"] as const, (webCtx) => {
    const webServer = webCtx.webServer as unknown as {
      register(route: {
        kind: "exact";
        path: string;
        handler: (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
        ) => void | Promise<void>;
      }): () => void;
    };
    const connection = webCtx.get("connection") as unknown as {
      requestRejection(request: {
        headers: import("node:http").IncomingHttpHeaders;
      }): number | undefined;
    };
    return webCtx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: SESSION_USAGE_PATH,
          handler: async (req, res) => {
            const rejection = connection.requestRejection(req);
            if (rejection !== undefined) {
              res.writeHead(rejection);
              res.end(rejection === 401 ? "unauthorized" : "forbidden");
              return;
            }
            if (req.method !== "POST") {
              res.writeHead(405, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "method not allowed" }));
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const raw = Buffer.concat(chunks).toString("utf8");
            let envelope: { range?: unknown } = {};
            if (raw !== "") {
              try {
                envelope = JSON.parse(raw) as { range?: unknown };
              } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "request body is not JSON" }));
                return;
              }
            }
            try {
              const aggregate = await persistence.usageReport(
                resolveUsageSince(parseUsageRange(envelope.range), Date.now()),
              );
              const totals = sumUsage(aggregate.buckets);
              const subagent = sumUsage(aggregate.buckets.filter((bucket) => bucket.subagent));
              const human = sumUsage(aggregate.buckets.filter((bucket) => !bucket.subagent));
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ totals, subagent, human, ...aggregate }));
            } catch (error: unknown) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "usage report failed",
                }),
              );
            }
          },
        }),
      `session-rdb: ${SESSION_USAGE_PATH} route`,
    );
  });
}
