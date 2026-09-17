import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  chip: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "3px",
    maxWidth: "240px",
    color: "var(--dsw-alias-state-business-primary)",
    userSelect: "none",
  },
  marker: {
    flex: "none",
    fontWeight: "500",
  },
  icon: {
    flex: "none",
    alignSelf: "center",
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  invalid: {
    color: "var(--dsw-alias-state-error-primary)",
    textDecoration: "line-through",
    opacity: "0.7",
  },
} satisfies Record<string, CSSProps>;
