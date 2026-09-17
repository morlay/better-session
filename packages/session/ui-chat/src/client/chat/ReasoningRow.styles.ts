import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    "&:not([data-expanded])": {
      contain: "size layout",
      height: "calc(24px + var(--dsh-content-font-delta, 0px))",
    },
    "&[data-expanded] [data-open] [data-disclosure-row]": {
      position: "sticky",
      top: "0",
      zIndex: "1",
      background: "var(--dsw-alias-bg-base)",
    },
    "&[data-state='running'] [data-disclosure-row]::after": {
      content: "''",
      position: "absolute",
      insetBlock: "0",
      left: "0",
      width: "300px",
      background:
        "linear-gradient(\n    90deg,\n    transparent 0%,\n    color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%,\n    transparent 100%\n  )",
      animation: "dsh-reasoning-row-sweep 2.6s ease-out infinite",
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
    lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
    whiteSpace: "nowrap",
    "&[data-follow-end]": {
      display: "flex",
      justifyContent: "flex-end",
    },
    "&[data-follow-end] [data-reasoning-summary]": {
      flex: "0 0 auto",
      width: "max-content",
      minWidth: "100%",
      overflow: "visible",
      textAlign: "start",
      textOverflow: "clip",
    },
  },
  summaryText: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  thinkBody: {
    padding: "4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "dsh-reasoning-row-sweep": {
    "0%": {
      left: "-300px",
    },
    "90%, 100%": {
      left: "100%",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;
