import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    fontSize: "var(--dsh-content-font-size, 14px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-primary)",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    "& :global(.md-table-wide)": {
      "--dsh-table-spare": "max(0px, calc((100cqw - var(--dsh-chat-content-width)) / 2))",
      "--dsh-table-lead":
        "calc(var(--dsh-table-spare) + min(var(--dsh-chat-content-width), 100cqw) - 100%)",
      boxSizing: "border-box",
      width: "calc(100% + var(--dsh-table-lead) + var(--dsh-table-spare))",
      maxWidth: "none",
      marginLeft: "calc(-1 * var(--dsh-table-lead))",
      paddingLeft: "var(--dsh-table-lead)",
    },
    "& > [data-turn-process-inline][hidden]": {
      marginBottom: "-16px",
    },
  },
  stopped: {
    alignSelf: "flex-start",
    padding: "0 6px",
    borderRadius: "6px",
    background: "var(--dsw-alias-interactive-bg-hover)",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "11px",
    lineHeight: "18px",
  },
  actions: {
    marginTop: "16px",
    marginLeft: "-6px",
  },
} satisfies Record<string, CSSProps>;
