// Shared IconActions chrome for user and assistant messages: copy
// live, optional branch wiring, and an optional date-aware clock.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  IconBranchOutline16,
  IconCheckOutline16,
  IconCopyOutline16,
  IconEditOutline16,
  IconRefreshOutline16,
  Tooltip,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import {
  formatLatencySeconds,
  formatMessageClock,
  formatRunDuration,
  formatTokensPerSecond,
} from "./message-chrome.ts";
import { useCalendarDay } from "./use-calendar-day.ts";
import css from "./MessageIconActions.module.css";

export interface MessageIconActionsProps {
  text: string;

  time?: number | undefined;

  runMs?: number | undefined;

  ttftMs?: number | undefined;

  tokensPerSecond?: number | undefined;

  clock: "start" | "end";

  onBranch?: (() => void) | undefined;

  branchUnavailable?: boolean | undefined;

  className?: string | undefined;

  extraActions?: ReactNode;

  onEdit?: (() => void) | undefined;

  onRetry?: (() => void) | undefined;

  t: ChatViewSlotProps["t"];
}

export function MessageIconActions({
  text,
  time,
  runMs,
  ttftMs,
  tokensPerSecond,
  clock,
  onBranch,
  branchUnavailable = false,
  className,
  extraActions,
  onEdit,
  onRetry,
  t,
}: MessageIconActionsProps) {
  const day = useCalendarDay();
  const reasonId = useId();
  // Same success chrome as CodeBlock: a short check swap after the write,
  // gated so re-clicks during the window neither re-copy nor stack timers.
  const [copied, setCopied] = useState(false);
  const copyPending = useRef(false);
  const copyTimer = useRef<number | null>(null);
  const copyEpoch = useRef(0);
  useEffect(
    () => () => {
      copyEpoch.current += 1;
      copyPending.current = false;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return;
    const epoch = copyEpoch.current;
    copyPending.current = true;
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return;
      copyPending.current = false;
      if (!ok) return;
      setCopied(true);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1000);
    });
  }, [copied, text]);
  // The dot is decorative and stays hidden, but its margins separate the
  // readings only on screen: without the flanking spaces a reader hears one
  // run-on string ("Ran for 13sTTFT 0.2s12 tok/s") instead of three facts.
  const clockEl =
    time === undefined ? null : (
      <span className={clock === "start" ? css.timeStart : css.timeEnd}>
        {formatMessageClock(time, t, day)}
        {runMs !== undefined && (
          <>
            {" "}
            <span className={css.runTimeDot} aria-hidden>
              ·
            </span>{" "}
            {t("message.ranFor", { duration: formatRunDuration(runMs, t) })}
          </>
        )}
        {ttftMs !== undefined && (
          <>
            {" "}
            <span className={css.runTimeDot} aria-hidden>
              ·
            </span>{" "}
            {t("stats.ttftAverage", { duration: formatLatencySeconds(ttftMs) })}
          </>
        )}
        {tokensPerSecond !== undefined && (
          <>
            {" "}
            <span className={css.runTimeDot} aria-hidden>
              ·
            </span>{" "}
            {t("message.tokensPerSecond", { tps: formatTokensPerSecond(tokensPerSecond) })}
          </>
        )}
      </span>
    );
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`}>
      {clock === "start" ? clockEl : null}
      <Tooltip label={copied ? t("copied" as never) : t("copy" as never)} side="bottom">
        <button
          type="button"
          className={css.action}
          aria-label={copied ? t("copied" as never) : t("copy" as never)}
          onClick={onCopy}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
      {extraActions}
      {onEdit !== undefined && (
        <Tooltip label="编辑" side="bottom">
          <button type="button" className={css.action} aria-label="编辑" onClick={onEdit}>
            <IconEditOutline16 />
          </button>
        </Tooltip>
      )}
      {onRetry !== undefined && (
        <Tooltip label="重试此回合" side="bottom">
          <button type="button" className={css.action} aria-label="重试此回合" onClick={onRetry}>
            <IconRefreshOutline16 />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && (
        <Tooltip
          label={branchUnavailable ? t("message.branchUnavailable") : t("message.branch")}
          side="bottom"
        >
          {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
          <button
            type="button"
            className={css.action}
            aria-label={t("message.branch")}
            aria-disabled={branchUnavailable || undefined}
            aria-describedby={branchUnavailable ? reasonId : undefined}
            data-unavailable={branchUnavailable || undefined}
            onClick={branchUnavailable ? undefined : onBranch}
          >
            <IconBranchOutline16 />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} className={css.visuallyHidden}>
          {t("message.branchUnavailable")}
        </span>
      )}
      {clock === "end" ? clockEl : null}
    </div>
  );
}
