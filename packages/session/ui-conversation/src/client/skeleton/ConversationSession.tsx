/** Strict per-session header/body content inserted into the resident conversation layout. */

import { styling } from "@morlay/dsh-client-ui-primitives/client";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  ConversationSessionHeaderSlotProps,
  ConversationSessionSlotProps,
} from "../contract/slots.ts";
import { conversationPhase } from "../contract/snapshot.ts";
import { resolveActiveView } from "../view-selection.ts";
import { DefaultConversationViews } from "./DefaultConversationViews.tsx";
import { styles } from "./ConversationRoot.styles.ts";

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps;

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps;

interface Breadcrumb {
  readonly id: SessionId;
  readonly displayTitle: string;
  readonly subagent: boolean;
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = [];
  const seen = new Set<SessionId>();
  let cursor: SessionId | undefined = id;
  while (cursor !== undefined) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const summary: SessionSummary | undefined = list.byId[cursor];
    if (summary === undefined) break;
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === "subagent",
    });
    if (summary.origin !== "subagent") break;
    cursor = summary.parentId;
  }
  return chain;
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right.at(index);
      return (
        other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
      );
    })
  );
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the hidden blank-session header or visible title and tabs.
 */
export function ConversationSessionHeader({
  sessionId,
  useSession,
  useSessions,
  useConversation,
  useConversationViews,
  useStore,
  renderSlot,
  open,
  selectView,
  t,
}: ConversationSessionHeaderProps) {
  const tabs = useConversationViews((value) => value);
  const selectedId = useStore((s) => s.view);
  const active = resolveActiveView(tabs, selectedId);
  const ancestry = useSessions((s) => deriveAncestry(s, sessionId), equalBreadcrumbs);
  const session = useSession((s) => s);
  const conversation = useConversation((s) => s);
  const hideChrome = session.blank && conversationPhase(session, conversation) === "blank";

  return (
    <header
      {...styling.props(styles.header, hideChrome && styles.headerHidden)}
      data-conversation-header=""
      aria-hidden={hideChrome || undefined}
    >
      {!hideChrome && (
        <>
          <div {...styling.props(styles.titleRow)}>
            <div {...styling.props(styles.titleCluster)}>
              <nav {...styling.props(styles.crumbs)} aria-label={t("session.hierarchy")}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1;
                  const title = (
                    <button
                      type="button"
                      {...styling.props(
                        styles.crumb,
                        summary.subagent && styles.crumbSubagent,
                        last && styles.crumbCurrent,
                      )}
                      disabled={last}
                      onClick={() => {
                        open(summary.id);
                      }}
                    >
                      {summary.displayTitle}
                    </button>
                  );
                  const lineage = last || summary.subagent;
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...(last
                      ? {}
                      : {
                          openTitle: () => {
                            open(summary.id);
                          },
                        }),
                  };
                  return (
                    <span key={summary.id} {...styling.props(styles.crumbSeg)}>
                      {index > 0 && <span {...styling.props(styles.crumbSep)}>/</span>}
                      {lineage ? (
                        summary.subagent ? (
                          renderSlot("conversation.session.header.lineage", lineageOwner, {
                            fallback: title,
                          })
                        ) : (
                          <>
                            {title}
                            {renderSlot("conversation.session.header.lineage", lineageOwner, {
                              fallback: null,
                            })}
                          </>
                        )
                      ) : (
                        title
                      )}
                    </span>
                  );
                })}
                {ancestry.length === 0 && (
                  <span {...styling.props(styles.crumbCurrent)}>{sessionId}</span>
                )}
              </nav>
              <div {...styling.props(styles.headerActions)}>
                {renderSlot("conversation.session.header.actions", {})}
              </div>
            </div>
            <div {...styling.props(styles.headerUtilities)}>
              {renderSlot("conversation.session.header.utilities", {})}
            </div>
            <div {...styling.props(styles.headerCorner)} data-conversation-header-corner="">
              {renderSlot("conversation.session.header.corner", {})}
            </div>
          </div>
          {tabs.length > 1 && (
            <div {...styling.props(styles.tabs)} role="tablist">
              {tabs.map((viewTab) => (
                <button
                  key={viewTab.id}
                  type="button"
                  role="tab"
                  aria-selected={viewTab.id === active?.id}
                  {...styling.props(styles.tab, viewTab.id === active?.id && styles.tabActive)}
                  onClick={() => {
                    selectView(viewTab.id);
                  }}
                >
                  {viewTab.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </header>
  );
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession(props: ConversationSessionProps) {
  return <DefaultConversationViews {...props} />;
}
