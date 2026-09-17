import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    position: "relative",
    display: "inline-flex",
  },
  trigger: {
    display: "grid",
    placeItems: "center",
    flex: "none",
    width: "28px",
    height: "28px",
    border: "none",
    borderRadius: "999px",
    cornerShape: "round",
    background: "transparent",
    color: "var(--dsw-alias-label-secondary)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--dsw-alias-interactive-bg-hover)",
    },
  },
  track: {
    fill: "none",
    stroke: "var(--dsw-alias-border-l3)",
    strokeWidth: "2",
  },
  fill: {
    fill: "none",
    stroke: "var(--dsw-alias-label-tertiary)",
    strokeWidth: "2",
    strokeLinecap: "round",
  },
  panel: {
    position: "absolute",
    bottom: "calc(100% + 8px)",
    right: "0",
    zIndex: "100",
    boxSizing: "border-box",
    width: "264px",
    padding: "12px",
    border: "0",
    borderRadius: "12px",
    background: "var(--dsw-specific-menu)",
    "--dsw-elevation-stroke-color": "var(--dsw-alias-border-l1)",
    boxShadow: "var(--dsw-elevation-prominent)",
    fontSize: "12px",
    lineHeight: "20px",
    color: "var(--dsw-alias-label-secondary)",
    cursor: "default",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  figures: {
    marginLeft: "auto",
    fontWeight: "500",
    fontVariantNumeric: "tabular-nums",
    color: "var(--dsw-alias-label-primary)",
  },
  percent: {
    fontWeight: "500",
    color: "var(--dsw-alias-label-primary)",
  },
  headline: {
    color: "var(--dsw-alias-label-tertiary)",
    "&:empty": {
      display: "none",
    },
  },
  bar: {
    display: "flex",
    gap: "1px",
    margin: "10px 0 12px",
    height: "4px",
    borderRadius: "999px",
    cornerShape: "round",
    background: "var(--dsw-alias-interactive-bg-hover)",
    overflow: "hidden",
  },
  segment: {
    flex: "none",
    minWidth: "2px",
    height: "100%",
    borderRadius: "1px",
    background: "var(--meter-tint, var(--dsw-alias-label-tertiary))",
  },
  swatch: {
    display: "inline-block",
    marginRight: "6px",
    width: "8px",
    height: "8px",
    borderRadius: "2px",
    background: "var(--meter-tint)",
    verticalAlign: "baseline",
  },
  colorSystem: {
    "--meter-tint": "var(--dsw-static-neutral-bluish-400)",
  },
  colorTools: {
    "--meter-tint": "rgb(167, 139, 250)",
  },
  colorMessages: {
    "--meter-tint": "var(--dsw-static-blue-450)",
  },
  rows: {
    margin: "6px 0 0",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "2px 0",
    "& dt": {
      color: "var(--dsw-alias-label-secondary)",
    },
    "& dd": {
      margin: "0",
      fontVariantNumeric: "tabular-nums",
      color: "var(--dsw-alias-label-primary)",
    },
  },
} satisfies Record<string, CSSProps>;
