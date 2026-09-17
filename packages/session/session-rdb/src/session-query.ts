import type { Context } from "@deepseek-ai/cordis";
import { SessionQueryEngine, SessionQueryError, type Config } from "@deepseek-ai/dsh-session-query";

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
