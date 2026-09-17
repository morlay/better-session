import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  reference: {
    padding: "0 4px",
    borderRadius: "6px",
    lineHeight: "inherit",
    verticalAlign: "baseline",
    color: "var(--dsw-alias-state-business-primary)",
    background: "transparent",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    "&:hover": {
      background: "var(--dsw-alias-state-business-tertiary)",
    },
  },
  openable: {
    cursor: "pointer",
  },
  textRef: {
    display: "inline-block",
    maxWidth: "100%",
  },
} satisfies Record<string, CSSProps>;
