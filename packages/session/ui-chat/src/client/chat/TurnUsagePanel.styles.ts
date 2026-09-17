import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "inline-flex",
    minWidth: "0",
    "& + [data-turn-usage-root]": {
      marginLeft: "-6px",
      "@media (max-width: 480px)": {
        marginLeft: "0",
      },
    },
  },
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
    height: "calc(28px + var(--dsh-content-font-delta, 0px))",
    padding: "6px 8px",
    border: "none",
    borderRadius: "28px",
    background: "transparent",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    fontVariantNumeric: "tabular-nums",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    whiteSpace: "nowrap",
    cursor: "pointer",
    "& svg": {
      width: "calc(15px + var(--dsh-content-font-delta, 0px))",
      height: "calc(15px + var(--dsh-content-font-delta, 0px))",
      flex: "none",
    },
    "&:hover": {
      background: "var(--dsw-alias-interactive-bg-hover)",
      color: "var(--dsw-alias-label-secondary)",
    },
    "&[aria-expanded='true']": {
      background: "var(--dsw-alias-interactive-bg-hover)",
      color: "var(--dsw-alias-label-secondary)",
    },
    "@media (max-width: 480px)": {
      justifyContent: "center",
      width: "calc(28px + var(--dsh-content-font-delta, 0px))",
      padding: "6px",
    },
    "& [data-turn-usage-label]": {
      "@media (max-width: 480px)": {
        display: "none",
      },
    },
  },
  label: {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
} satisfies Record<string, CSSProps>;
