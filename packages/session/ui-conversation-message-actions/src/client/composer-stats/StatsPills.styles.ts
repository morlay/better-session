import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  // 上游 `StatsPills.module.css` 的 `.root` 原样：统计行在 composer dock 里是 shrink-wrap 的
  // 一个条目，与同为 dock 子项的上下文占用按钮并排——行内间距由 dock 的 `gap: 12px` 统一，
  // 统计自己不再撑满整行（撑满会把占用按钮挤到行尾，两块之间的间距就跟行内间距对不上）。
  root: {
    display: "flex",
    justifyContent: "center",
    gap: "12px",
    minWidth: "0",
    maxWidth: "100%",
    boxSizing: "border-box",
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
