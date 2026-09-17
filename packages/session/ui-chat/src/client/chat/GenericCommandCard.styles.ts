import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    "&[data-state='running'] [data-disclosure-row]::after": {
      content: "''",
      position: "absolute",
      insetBlock: "0",
      left: "0",
      width: "300px",
      background:
        "linear-gradient(\n    90deg,\n    transparent 0%,\n    color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%,\n    transparent 100%\n  )",
      animation: "dsh-command-row-sweep 2.6s ease-out infinite",
      pointerEvents: "none",
      "@media (prefers-reduced-motion: reduce)": {
        animation: "none",
      },
    },
  },
  row: {
    position: "relative",
    overflow: "hidden",
  },
  leading: {
    flexShrink: "0",
  },
  chevron: {
    color: "var(--dsw-alias-label-secondary)",
  },
  title: {
    fontWeight: "400",
  },
  separator: {
    flex: "none",
    width: "2px",
    height: "2px",
    margin: "0 8px",
    borderRadius: "1px",
    background: "var(--dsw-alias-label-caption)",
  },
  summary: {
    minWidth: "0",
    overflow: "hidden",
    flex: "1 1 auto",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "&[data-error]": {
      color: "var(--dsw-alias-state-error-primary)",
    },
  },
  body: {
    "&[data-error]": {
      color: "var(--dsw-alias-state-error-primary)",
    },
    maxHeight: "260px",
    margin: "4px 0 4px 4px",
    padding: "12px 16px",
    overflow: "auto",
    border: "0.5px solid var(--dsw-alias-border-l1)",
    borderRadius: "12px",
    background: "var(--dsw-alias-markdown-code-block)",
    color: "var(--dsw-alias-label-primary)",
    font: "var(--dsw-font-markdown-code-block-small)",
    whiteSpace: "pre-wrap",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "dsh-command-row-sweep": {
    "0%": {
      left: "-300px",
    },
    "90%, 100%": {
      left: "100%",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;
