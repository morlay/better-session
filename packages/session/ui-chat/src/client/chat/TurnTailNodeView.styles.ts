import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  actions: {
    marginTop: "4px",
    marginLeft: "-6px",
  },
} satisfies Record<string, CSSProps>;
