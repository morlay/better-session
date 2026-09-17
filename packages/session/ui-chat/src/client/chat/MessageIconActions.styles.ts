import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: "calc(28px + var(--dsh-content-font-delta, 0px))",
  },
  timeStart: {
    paddingRight: "12px",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-tertiary)",
    whiteSpace: "nowrap",
  },
  timeEnd: {
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-tertiary)",
    whiteSpace: "nowrap",
  },
  action: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "calc(28px + var(--dsh-content-font-delta, 0px))",
    height: "calc(28px + var(--dsh-content-font-delta, 0px))",
    padding: "6px",
    border: "none",
    borderRadius: "28px",
    background: "transparent",
    color: "var(--dsw-alias-label-tertiary)",
    cursor: "pointer",
    "& svg": {
      width: "calc(15px + var(--dsh-content-font-delta, 0px))",
      height: "calc(15px + var(--dsh-content-font-delta, 0px))",
    },
    "&:hover": {
      background: "var(--dsw-alias-interactive-bg-hover)",
      color: "var(--dsw-alias-label-secondary)",
    },
    "&[data-unavailable]": {
      cursor: "default",
      opacity: "0.4",
    },
    "&[data-unavailable]:hover": {
      background: "transparent",
      color: "var(--dsw-alias-label-tertiary)",
    },
  },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProps>;

export const globals = {
  "[data-actions-reveal='hover'] [data-message-actions],\n  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(\n    ~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])\n  ) [data-message-actions]":
    {
      opacity: "0",
      transition: "opacity 80ms ease",
    },
  "[data-actions-reveal='hover']:hover [data-message-actions],\n  [data-actions-reveal='hover']:focus-within [data-message-actions],\n  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(\n    ~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])\n  ):hover [data-message-actions],\n  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(\n    ~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])\n  ):focus-within [data-message-actions]":
    {
      opacity: "1",
    },
} satisfies Record<string, CSSProps>;
