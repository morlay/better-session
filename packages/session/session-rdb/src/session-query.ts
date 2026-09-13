import type { Context } from "@deepseek-ai/cordis";
import { SessionQueryEngine, SessionQueryError, type Config } from "@deepseek-ai/dsh-session-query";

// 会话查询服务的 rdb 实现：精确读 / 过滤 / 血缘全部复用上游基类（数据面走
// ctx.sessions 与我们的 ctx.sessionPersistence），这里只接管服务所有权。
// 全文检索与官方 `openAt: never` 装配保持一致——直接拒绝，不引入 FTS 索引、
// node:sqlite 或派生库，搜索语义留待显式实现（见 ADR 0006）。
export class SessionQueryRdb extends SessionQueryEngine {
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config);
  }

  override async searchSessions(): Promise<never> {
    throw searchDisabled();
  }

  override async searchEvents(): Promise<never> {
    throw searchDisabled();
  }
}

function searchDisabled(): SessionQueryError {
  return new SessionQueryError(
    "session search is disabled: this deployment serves session queries from the rdb backend without a full-text index",
    "SESSION_QUERY_SEARCH_DISABLED",
  );
}
