// 「对话管理」页面：已归档会话的搜索、取消归档、导出、删除，以及导入为新会话与孤儿数据 GC。
// 数据面只读框架标准座位（useSessions / useWorkspaces），动作面只读注入面。
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Checkbox,
  IconSearchOutline16,
  Input,
  Modal,
  Pill,
  Tag,
  relativeTime,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  ConversationManagerRequestError,
  type ConversationManagerFace,
  type SessionUsageReport,
  type UsageBucket,
  type UsageTotals,
} from "./controller.ts";
import { formatTokens } from "./format.ts";
import { styles } from "./ConversationManagerPage.styles.ts";

/** 一页的行数（会话列表）。 */
const PAGE_SIZE = 20;

/** 统计视图按会话列出时的行数上限。 */
const USAGE_SESSION_ROWS = 20;

/** 页面 props：main 座位的运行时份额 + 本包字典 + 注入的动作。 */
export type ConversationManagerPageProps = PropsRuntime<"main"> &
  PropsLocale<"conversationManager"> &
  InjectFace<ConversationManagerFace>;

type Translate = ConversationManagerPageProps["t"];

/** GC 的三段状态：确认 → 运行（阻塞界面）→ 收尾。 */
type GcPhase = "idle" | "confirm" | "running";

interface ConversationRow {
  id: SessionId;
  title: string;
  /** 所属工作区标题；不在任何工作区里的会话用未分组文案。 */
  workspace: string;
  /** 只有已归档的行允许取消归档与删除（host 侧同样守卫）。 */
  archived: boolean;
  /** 子代理派生会话：默认不显示（既不可删也不可取消归档）。 */
  subagent: boolean;
  updatedAt: number;
}

/** 行上显示的紧凑相对时间。 */
function timeLabel(updatedAt: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(updatedAt, now);
  return unit === "now" ? t("time.now") : t(`time.${unit}`, { n });
}

/** 标题或工作区名命中归一化后的查询。 */
function matches(row: ConversationRow, normalizedQuery: string): boolean {
  return (
    normalizedQuery.length === 0 ||
    row.title.toLowerCase().includes(normalizedQuery) ||
    row.workspace.toLowerCase().includes(normalizedQuery)
  );
}

/** host 错误码 → 可读文案；没有码时保留原文。 */
function failureText(error: unknown, t: Translate): string {
  const code = error instanceof ConversationManagerRequestError ? error.code : undefined;
  if (code === "SESSION_NOT_ARCHIVED") return t("failure.notArchived");
  if (code === "SESSION_LIVE") return t("failure.live");
  if (code === "SESSION_NOT_FOUND") return t("failure.missing");
  return t("failure.other", { reason: error instanceof Error ? error.message : String(error) });
}

export function ConversationManagerPage({
  t,
  useSessions,
  useWorkspaces,
  archive,
  unarchive,
  remove,
  exportZip,
  importZip,
  collectGarbage,
  loadUsage,
}: ConversationManagerPageProps): ReactNode {
  const sessions = useSessions((state) => state);
  const workspaces = useWorkspaces((state) => state);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [showSubagents, setShowSubagents] = useState(false);
  const [view, setView] = useState<PageView>("sessions");
  const [usageTab, setUsageTab] = useState<UsageTab>("overview");
  const [usage, setUsage] = useState<SessionUsageReport | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConversationRow | null>(null);
  const [gcPhase, setGcPhase] = useState<GcPhase>("idle");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ungrouped = t("ungrouped");

  // 全量会话：会话目录（ids）∪ 归档集，按最近活动在前；没有加载到 summary 的成员不产生行。
  const rows = useMemo<ConversationRow[]>(() => {
    const owners = new Map<string, string>();
    for (const workspace of workspaces.items) {
      for (const id of workspace.sessionIds) owners.set(id, workspace.title);
    }
    const archivedIds = new Set<SessionId>(workspaces.archivedSessionIds);
    const ids = new Set<SessionId>([...sessions.ids, ...workspaces.archivedSessionIds]);
    return [...ids]
      .flatMap((id) => {
        const summary = sessions.byId[id];
        if (summary === undefined) return [];
        return [
          {
            id,
            title: summary.displayTitle,
            workspace: owners.get(id) ?? ungrouped,
            archived: archivedIds.has(id),
            subagent: summary.origin === "subagent",
            updatedAt: summary.updatedAt,
          },
        ];
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }, [workspaces, sessions.ids, sessions.byId, ungrouped]);

  // 一个动作的收尾：成败都收掉弹窗，失败把原因落到页面上的提示行。
  const run = (action: Promise<unknown>, settle?: () => void): void => {
    setFailure(null);
    setNotice(null);
    void action.then(
      () => {
        settle?.();
      },
      (error: unknown) => {
        settle?.();
        setFailure(failureText(error, t));
      },
    );
  };

  const startGc = (): void => {
    setGcPhase("running");
    setFailure(null);
    setNotice(null);
    void collectGarbage().then(
      (result) => {
        setGcPhase("idle");
        setNotice(t("gc.done", { sessions: result.orphanSessions, events: result.orphanEvents }));
      },
      (error: unknown) => {
        setGcPhase("idle");
        setFailure(failureText(error, t));
      },
    );
  };

  // 统计是重查询（全库聚合）：只在第一次进入统计视图时拉一次，维度切换不再请求。
  const openUsage = (): void => {
    setView("usage");
    if (usage !== null || usageLoading) return;
    setUsageLoading(true);
    setUsageError(null);
    void loadUsage()
      .then(
        (report) => {
          setUsage(report);
        },
        (error: unknown) => {
          setUsageError(failureText(error, t));
        },
      )
      .finally(() => {
        setUsageLoading(false);
      });
  };

  if (sessions.phase !== "ready") {
    return <p {...styling.props(styles.status)}>{t("loading")}</p>;
  }

  const now = Date.now();
  // 子代理派生会话默认不列：它们不可删也不可取消归档，只会淹没真实对话。
  const listed = showSubagents ? rows : rows.filter((row) => !row.subagent);
  const matched = listed.filter((row) => matches(row, query.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = matched.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const confirmed = confirming;

  return (
    <div {...styling.props(styles.page)}>
      <div {...styling.props(styles.header)}>
        <h1 {...styling.props(styles.title)}>{t("title")}</h1>
        <div {...styling.props(styles.tabs)}>
          <Pill
            active={view === "sessions"}
            onClick={() => {
              setView("sessions");
            }}
          >
            {t("view.sessions")}
          </Pill>
          <Pill active={view === "usage"} onClick={openUsage}>
            {t("view.usage")}
          </Pill>
        </div>
        <div {...styling.props(styles.headerActions)}>
          <Button
            variant="outline"
            size="sm"
            disabled={importing}
            aria-busy={importing}
            aria-label={importing ? t("importing") : t("import")}
            onClick={() => {
              fileRef.current?.click();
            }}
          >
            {importing ? t("importing") : t("import")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={gcPhase !== "idle"}
            aria-label={t("gc.button")}
            onClick={() => {
              setFailure(null);
              setNotice(null);
              setGcPhase("confirm");
            }}
          >
            {t("gc.button")}
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file === undefined) return;
            setImporting(true);
            setFailure(null);
            setNotice(null);
            void importZip(file)
              .then(
                () => {
                  setNotice(t("imported"));
                },
                (error: unknown) => {
                  setFailure(failureText(error, t));
                },
              )
              .finally(() => {
                setImporting(false);
              });
          }}
        />
      </div>
      {view === "usage" ? (
        <UsageView
          report={usage}
          loading={usageLoading}
          error={usageError}
          tab={usageTab}
          onTab={setUsageTab}
          t={t}
        />
      ) : (
        <>
          <div {...styling.props(styles.filters)}>
            <Input
              className={styling.className(styles.search)}
              type="search"
              icon={<IconSearchOutline16 />}
              value={query}
              placeholder={t("search")}
              aria-label={t("search")}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setPage(1);
              }}
            />
            <Checkbox
              checked={showSubagents}
              label={t("showSubagents")}
              onChange={(next) => {
                setShowSubagents(next);
                setPage(1);
              }}
            />
          </div>
          {notice === null ? null : <p {...styling.props(styles.status)}>{notice}</p>}
          {failure === null ? null : (
            <p {...styling.props(styles.failure)} role="alert">
              {failure}
            </p>
          )}
          {listed.length === 0 ? <p {...styling.props(styles.status)}>{t("empty")}</p> : null}
          {listed.length > 0 && matched.length === 0 ? (
            <p {...styling.props(styles.status)}>{t("emptySearch")}</p>
          ) : null}
          {visible.length > 0 ? (
            <ul {...styling.props(styles.list)}>
              {visible.map((row) => (
                <li key={row.id} {...styling.props(styles.row)}>
                  <span {...styling.props(styles.identity)}>
                    <span {...styling.props(styles.titleLine)}>
                      <span {...styling.props(styles.rowTitle)}>{row.title}</span>
                      {row.archived ? <Tag tone="neutral">{t("archived")}</Tag> : null}
                      {row.subagent ? <Tag tone="quiet">{t("subagent")}</Tag> : null}
                    </span>
                    <span {...styling.props(styles.meta)}>
                      {[row.workspace, timeLabel(row.updatedAt, now, t)].join(" · ")}
                    </span>
                  </span>
                  <span {...styling.props(styles.actions)}>
                    {row.archived ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("unarchiveNamed", { title: row.title })}
                        onClick={() => {
                          run(unarchive(row.id));
                        }}
                      >
                        {t("unarchive")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("archiveNamed", { title: row.title })}
                        onClick={() => {
                          run(archive(row.id));
                        }}
                      >
                        {t("archive")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("exportNamed", { title: row.title })}
                      onClick={() => {
                        run(exportZip(row.id));
                      }}
                    >
                      {t("export")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!row.archived}
                      aria-label={t("removeNamed", { title: row.title })}
                      onClick={() => {
                        setFailure(null);
                        setNotice(null);
                        setConfirming(row);
                      }}
                    >
                      {t("remove")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {matched.length > 0 ? (
            <div {...styling.props(styles.pagination)}>
              <Button
                variant="ghost"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => {
                  setPage(currentPage - 1);
                }}
              >
                {t("page.previous")}
              </Button>
              <span {...styling.props(styles.paginationLabel)}>
                {t("page.label", { page: currentPage, total: pageCount })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={currentPage >= pageCount}
                onClick={() => {
                  setPage(currentPage + 1);
                }}
              >
                {t("page.next")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Modal
        open={confirmed !== null}
        onClose={() => {
          setConfirming(null);
        }}
        title={t("confirmTitle")}
        closeLabel={t("close")}
        description={t("confirmDescription")}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(null);
              }}
            >
              {t("confirmCancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirmed === null) return;
                run(remove(confirmed.id), () => {
                  setConfirming(null);
                });
              }}
            >
              {t("confirmAccept")}
            </Button>
          </>
        }
      />
      <Modal
        open={gcPhase === "confirm"}
        onClose={() => {
          setGcPhase("idle");
        }}
        title={t("gc.title")}
        closeLabel={t("close")}
        description={t("gc.description")}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setGcPhase("idle");
              }}
            >
              {t("gc.cancel")}
            </Button>
            <Button variant="primary" onClick={startGc}>
              {t("gc.confirm")}
            </Button>
          </>
        }
      />
      {/* 运行期不给关闭手段：没有关闭按钮，mask 与 Escape 都只走空 onClose。 */}
      <Modal open={gcPhase === "running"} onClose={() => {}} headless title={t("gc.title")}>
        <div {...styling.props(styles.blocking)}>
          <span {...styling.props(styles.spinner)} aria-hidden="true" />
          <p {...styling.props(styles.blockingText)}>{t("gc.running")}</p>
        </div>
      </Modal>
    </div>
  );
}

/** 一层视图：会话列表 / 用量统计。 */
type PageView = "sessions" | "usage";

/** 统计视图的二层维度。 */
type UsageTab = "overview" | "daily" | "models" | "sessions";

/** 紧凑明细：输入 · 输出 · 缓存读取 · 推理 · 事件。 */
function usageMeta(totals: UsageTotals, t: Translate): string {
  return [
    `${t("usage.input")} ${formatTokens(totals.inputTokens)}`,
    `${t("usage.output")} ${formatTokens(totals.outputTokens)}`,
    `${t("usage.cacheRead")} ${formatTokens(totals.cacheReadTokens)}`,
    `${t("usage.reasoning")} ${formatTokens(totals.reasoningTokens)}`,
    `${t("usage.events")} ${formatTokens(totals.events)}`,
  ].join(" · ");
}

interface UsageListRow {
  key: string;
  label: string;
  totals: UsageTotals;
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

/** 把桶按一个键折叠成行并按合计降序（按天 / 按模型都用它）。 */
function foldBuckets(
  buckets: readonly UsageBucket[],
  keyOf: (bucket: UsageBucket) => string,
): UsageListRow[] {
  const folded = new Map<string, UsageListRow>();
  for (const bucket of buckets) {
    const key = keyOf(bucket);
    const row = folded.get(key) ?? { key, label: key, totals: emptyTotals() };
    row.totals.events += bucket.events;
    row.totals.inputTokens += bucket.inputTokens;
    row.totals.outputTokens += bucket.outputTokens;
    row.totals.cacheReadTokens += bucket.cacheReadTokens;
    row.totals.reasoningTokens += bucket.reasoningTokens;
    row.totals.totalTokens += bucket.totalTokens;
    folded.set(key, row);
  }
  return [...folded.values()].sort(
    (left, right) => right.totals.totalTokens - left.totals.totalTokens,
  );
}

function UsageList({ rows, t }: { rows: readonly UsageListRow[]; t: Translate }): ReactNode {
  if (rows.length === 0) return <p {...styling.props(styles.status)}>{t("usage.empty")}</p>;
  return (
    <ul {...styling.props(styles.usageList)}>
      {rows.map((row) => (
        <li key={row.key} {...styling.props(styles.usageRow)}>
          <span {...styling.props(styles.usageRowLabel)}>{row.label}</span>
          <span {...styling.props(styles.usageRowTotal)}>
            {formatTokens(row.totals.totalTokens)}
          </span>
          <span {...styling.props(styles.usageRowMeta)}>{usageMeta(row.totals, t)}</span>
        </li>
      ))}
    </ul>
  );
}

function UsageOverview({ report, t }: { report: SessionUsageReport; t: Translate }): ReactNode {
  const cells = [
    { key: "input", label: t("usage.input"), value: report.totals.inputTokens },
    { key: "output", label: t("usage.output"), value: report.totals.outputTokens },
    { key: "cache", label: t("usage.cacheRead"), value: report.totals.cacheReadTokens },
    { key: "reasoning", label: t("usage.reasoning"), value: report.totals.reasoningTokens },
    { key: "total", label: t("usage.total"), value: report.totals.totalTokens },
    { key: "events", label: t("usage.events"), value: report.totals.events },
  ];
  return (
    <>
      <div {...styling.props(styles.usageGrid)}>
        {cells.map((cell) => (
          <div key={cell.key} {...styling.props(styles.usageCell)}>
            <span {...styling.props(styles.usageCellLabel)}>{cell.label}</span>
            <span {...styling.props(styles.usageCellValue)}>{formatTokens(cell.value)}</span>
          </div>
        ))}
      </div>
      <ul {...styling.props(styles.usageList)}>
        <li {...styling.props(styles.usageRow)}>
          <span {...styling.props(styles.usageRowLabel)}>{t("usage.subagentOnly")}</span>
          <span {...styling.props(styles.usageRowTotal)}>
            {formatTokens(report.subagent.totalTokens)}
          </span>
          <span {...styling.props(styles.usageRowMeta)}>{usageMeta(report.subagent, t)}</span>
        </li>
      </ul>
    </>
  );
}

/** 统计视图：二层维度切换 + 总览网格 / 三个折叠列表（按天 / 按模型 / 按会话）。 */
function UsageView({
  report,
  loading,
  error,
  tab,
  onTab,
  t,
}: {
  report: SessionUsageReport | null;
  loading: boolean;
  error: string | null;
  tab: UsageTab;
  onTab: (tab: UsageTab) => void;
  t: Translate;
}): ReactNode {
  const items: UsageTab[] = ["overview", "daily", "models", "sessions"];
  const labels: Record<UsageTab, string> = {
    overview: t("usage.overview"),
    daily: t("usage.daily"),
    models: t("usage.models"),
    sessions: t("usage.sessions"),
  };
  const rows: readonly UsageListRow[] =
    report === null || tab === "overview"
      ? []
      : tab === "daily"
        ? foldBuckets(report.buckets, (bucket) => bucket.day)
        : tab === "models"
          ? foldBuckets(
              report.buckets,
              (bucket) =>
                `${bucket.provider ?? t("usage.unknownModel")} / ${bucket.model ?? t("usage.unknownModel")}`,
            )
          : report.sessions
              .map((row) => ({
                key: row.sessionId,
                label: row.title ?? row.sessionId,
                totals: row,
              }))
              .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens)
              .slice(0, USAGE_SESSION_ROWS);
  return (
    <div {...styling.props(styles.usage)}>
      <div {...styling.props(styles.tabs)}>
        {items.map((item) => (
          <Pill
            key={item}
            active={tab === item}
            onClick={() => {
              onTab(item);
            }}
          >
            {labels[item]}
          </Pill>
        ))}
      </div>
      {loading ? <p {...styling.props(styles.status)}>{t("usage.loading")}</p> : null}
      {error === null ? null : (
        <p {...styling.props(styles.failure)} role="alert">
          {error}
        </p>
      )}
      {report === null ? null : tab === "overview" ? (
        <UsageOverview report={report} t={t} />
      ) : (
        <UsageList rows={rows} t={t} />
      )}
    </div>
  );
}
