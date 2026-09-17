import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "flex",
    justifyContent: "center",
    gap: "12px",
    maxWidth: "var(--dsh-chat-content-width)",
    width: "100%",
    margin: "0 auto",
    boxSizing: "border-box",
    padding: "4px calc(var(--dsh-composer-side-clearance) + 16px) 0px",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  },
  anchor: {
    display: "inline-flex",
    minWidth: "0",
  },
  pill: {
    cursor: "pointer",

    "&:hover, &[aria-expanded='true']": {
      background: "var(--dsw-alias-interactive-bg-hover)",
      color: "var(--dsw-alias-label-secondary)",
    },
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    boxSizing: "border-box",
    maxWidth: "100%",
    padding: "1px 8px",
    border: "none",
    borderRadius: "24px",
    background: "transparent",
    color: "var(--dsw-alias-label-tertiary)",
    font: "inherit",
    fontVariantNumeric: "tabular-nums",
    lineHeight: "inherit",
    whiteSpace: "nowrap",
    "& svg": {
      width: "14px",
      height: "14px",
      flex: "none",
    },
  },
  label: {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  sep: {
    color: "var(--dsw-alias-separator-primary)",
    margin: "0 6px",
  },
} satisfies Record<string, CSSProps>;
