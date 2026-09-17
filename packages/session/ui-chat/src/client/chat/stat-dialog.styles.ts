import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  panel: {
    position: "fixed",
    zIndex: "1100",
    boxSizing: "border-box",
    width: "max-content",
    minWidth: "min(300px, calc(100vw - 24px))",
    maxWidth: "min(440px, calc(100vw - 24px))",
    padding: "16px",
    border: "0",
    borderRadius: "12px",
    background: "var(--dsw-specific-menu)",
    "--dsw-elevation-stroke-color": "var(--dsw-alias-border-l1)",
    boxShadow: "var(--dsw-elevation-prominent)",
    fontSize: "12px",
    lineHeight: "18px",
    color: "var(--dsw-alias-label-secondary)",
    cursor: "default",
  },
  title: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    marginBottom: "8px",
    color: "var(--dsw-alias-label-primary)",
    fontWeight: "500",
  },
  titleRule: {
    marginBottom: "10px",
    borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  },
  titleValue: {
    fontVariantNumeric: "tabular-nums",
  },
  titleLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: "0",
    "& svg": {
      width: "14px",
      height: "14px",
      flex: "none",
    },
  },
  details: {
    display: "grid",
    gridTemplateColumns: "minmax(76px, auto) minmax(0, 1fr)",
    gap: "6px 16px",
    margin: "0",
    color: "var(--dsw-alias-label-tertiary)",
    "& dt": {
      minWidth: "0",
      margin: "0",
    },
    "& dd": {
      minWidth: "0",
      margin: "0",
      color: "var(--dsw-alias-label-secondary)",
      fontVariantNumeric: "tabular-nums",
      textAlign: "right",
    },
  },
  reasoning: {
    color: "var(--dsw-alias-label-tertiary)",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProps>;
