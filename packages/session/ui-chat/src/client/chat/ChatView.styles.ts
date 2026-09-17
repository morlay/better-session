import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minHeight: "0",
    flex: "1 1 auto",
  },
  scroll: {
    flex: "1 1 auto",
    minHeight: "0",
    overflowY: "auto",
    padding: "16px calc(var(--dsh-composer-side-clearance) + 16px)",
    containerType: "inline-size",
  },
  column: {
    maxWidth: "var(--dsh-chat-content-width)",
    width: "100%",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    "& > :not([hidden]):not([data-chat-flow-item]:empty)\n  ~ :not([hidden]):not([data-chat-flow-item]:empty)":
      {
        marginTop: "var(--dsh-chat-flow-gap, 16px)",
      },
  },
  flowItem: {
    minWidth: "0",
    "&[data-turn-process-answer]": {
      "--dsh-chat-flow-gap": "8px",
    },
    "&:empty": {
      display: "none",
    },
  },
  callRow: {
    borderRadius: "6px",
  },
  turnStatus: {
    alignSelf: "flex-start",
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    height: "calc(26px + var(--dsh-content-font-delta, 0px))",
    font: "var(--dsw-font-s-strong-14)",
    fontSize: "var(--dsh-content-font-size, 14px)",
    lineHeight: "calc(22px + var(--dsh-content-font-delta, 0px))",
    whiteSpace: "nowrap",
    background:
      "linear-gradient(\n    90deg,\n    var(--dsw-static-deepseek-500) 0%,\n    var(--dsw-static-deepseek-500) 40%,\n    var(--dsw-static-deepseek-200) 50%,\n    var(--dsw-static-deepseek-500) 60%,\n    var(--dsw-static-deepseek-500) 100%\n  )",
    backgroundPosition: "100% 0",
    backgroundSize: "250% 100%",
    backgroundClip: "text",
    color: "transparent",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    animation: "dsh-turn-status-shimmer 1.8s linear infinite",
    "@media (prefers-reduced-motion: reduce)": {
      backgroundPosition: "0 0",
      backgroundSize: "100% 100%",
      animation: "none",
    },
  },
  turnStatusClock: {
    marginLeft: "8px",
    font: "var(--dsw-font-xs-13)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
    fontWeight: "400",
    fontVariantNumeric: "tabular-nums",
    color: "var(--dsw-alias-label-caption)",
    WebkitTextFillColor: "var(--dsw-alias-label-caption)",
  },
  hint: {
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(18px + var(--dsh-content-font-delta-secondary, 0px))",
  },
  openError: {
    color: "var(--dsw-alias-state-error-primary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(18px + var(--dsh-content-font-delta-secondary, 0px))",
  },
  older: {
    display: "flex",
    justifyContent: "center",
    "& button": {
      border: "none",
      borderRadius: "14px",
      padding: "4px 12px",
      fontSize: "12px",
      color: "var(--dsw-alias-label-secondary)",
      background: "var(--dsw-alias-interactive-bg-hover-solid)",
      cursor: "pointer",
    },
    "& button:disabled": {
      cursor: "default",
      opacity: "0.6",
    },
  },
  toBottomSlot: {
    position: "sticky",
    bottom: "16px",
    zIndex: "8",
    height: "0",
    display: "flex",
    justifyContent: "flex-end",
    paddingRight: "max(0px, calc((100% - var(--dsh-chat-content-width)) / 2))",
    pointerEvents: "none",
  },
  toBottom: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "34px",
    height: "34px",
    marginTop: "-34px",
    padding: "0",
    border: "0",
    "--dsw-elevation-stroke-color": "var(--dsw-alias-border-l3)",
    borderRadius: "100px",
    cornerShape: "round",
    color: "var(--dsw-alias-label-primary)",
    background: "var(--dsw-alias-button-floating-fill)",
    boxShadow: "var(--dsw-elevation-panel)",
    cursor: "pointer",
    pointerEvents: "auto",
    "&:hover": {
      background: "var(--dsw-alias-button-floating-hover)",
    },
  },
  modalAction: {
    minWidth: "72px",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "dsh-turn-status-shimmer": {
    to: {
      backgroundPosition: "0 0",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;

export const globals = {
  "[data-conversation-scroll] [data-chat-view='root']": {
    flex: "0 0 auto",
    minHeight: "auto",
    height: "auto",
  },
  "[data-conversation-scroll] [data-chat-view='scroll']": {
    overflow: "visible",
    flex: "0 0 auto",
    minHeight: "auto",
  },
  "[data-conversation-scroll] [data-chat-view='to-bottom']": {
    bottom: "calc(var(--dsh-composer-height, 152px) + 16px)",
  },
} satisfies Record<string, CSSProps>;
