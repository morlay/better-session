import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "28px",
  },
  timeStart: {
    paddingRight: "12px",
    fontSize: "14px",
    lineHeight: "24px",
    color: "var(--dsw-alias-label-tertiary)",
    whiteSpace: "nowrap",
  },
  timeEnd: {
    paddingLeft: "12px",
    fontSize: "14px",
    lineHeight: "24px",
    color: "var(--dsw-alias-label-tertiary)",
    whiteSpace: "nowrap",
    "&)": {
      "@media (hover: hover)": {
        opacity: "1",
      },
    },
  },
  runTimeDot: {
    margin: "0 10px",
  },
  action: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    padding: "6px",
    border: "none",
    borderRadius: "28px",
    background: "transparent",
    color: "var(--dsw-alias-label-tertiary)",
    cursor: "pointer",
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
  "[data-time-hover-root] [data-time-label]": {
    opacity: "0",
    transition: "opacity 80ms ease",
  },
  "[data-time-hover-root]:hover :is(.timeStart, .timeEnd),\n  [data-time-hover-root]:focus-within :is(.timeStart, .timeEnd)":
    {
      opacity: "1",
    },
} satisfies Record<string, CSSProps>;
