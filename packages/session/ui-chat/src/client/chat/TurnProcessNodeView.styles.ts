import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    width: "100%",
    minWidth: "0",
    height: "33px",
    padding: "0 0 8px",
    border: "none",
    borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
    background: "none",
    color: "var(--dsw-alias-label-secondary)",
    cursor: "pointer",
    textAlign: "left",
    "&:not([data-open])": {
      marginBottom: "8px",
    },
    "&[data-open] .dsh-node-chevron": {
      transform: "rotate(0deg)",
    },
  },
  chevron: {
    flex: "none",
    width: "16px",
    height: "16px",
    marginLeft: "6px",
    color: "var(--dsw-alias-label-tertiary)",
    transform: "rotate(-90deg)",
    transition: "transform 100ms ease",
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
  label: {
    minWidth: "0",
    overflow: "hidden",
    fontSize: "14px",
    lineHeight: "24px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProps>;
