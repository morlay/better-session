import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProps>;
