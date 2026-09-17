import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "16px 0",
    borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
  },
  rowText: {
    flex: "1",
    minWidth: "0",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    paddingRight: "48px",
  },
  title: {
    fontSize: "14px",
    fontWeight: "400",
    lineHeight: "22px",
    color: "var(--dsw-alias-label-primary)",
  },
  desc: {
    fontSize: "12px",
    fontWeight: "400",
    lineHeight: "18px",
    color: "var(--dsw-alias-label-tertiary)",
  },
  selector: {
    display: "inline-flex",
    alignItems: "center",
    gap: "12px",
    height: "36px",
    padding: "0 14px",
    border: "none",
    borderRadius: "18px",
    background: "var(--dsw-alias-bg-module-platform)",
    font: "inherit",
    fontSize: "14px",
    lineHeight: "22px",
    color: "var(--dsw-alias-label-primary)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--dsw-alias-interactive-bg-hover)",
    },
  },
  chevron: {
    flex: "none",
  },
} satisfies Record<string, CSSProps>;
