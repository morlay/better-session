import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    minWidth: "0",
    "&[data-open]": {
      paddingBottom: "4px",
    },
  },
  chevron: {
    color: "var(--dsw-alias-label-secondary)",
  },
  sep: {
    flex: "none",
    width: "2px",
    height: "2px",
    margin: "0 8px",
    borderRadius: "1px",
    background: "var(--dsw-alias-label-caption)",
  },
  source: {
    flex: "none",
    minWidth: "0",
    overflow: "hidden",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  summary: {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: {
    boxSizing: "border-box",
    width: "calc(100% - 22px - var(--dsh-content-font-delta, 0px))",
    maxHeight: "141px",
    margin: "4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px))",
    overflow: "auto",
    padding: "10px 16px 12px 12px",
    border: "none",
    borderRadius: "8px",
    background: "var(--dsw-alias-markdown-code-block)",
    color: "var(--dsw-alias-label-tertiary)",
    font: "400 11px/16px var(--ds-font-family-code)",
  },
} satisfies Record<string, CSSProps>;
