import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    boxSizing: "border-box",
    flex: "none",
    overflow: "hidden",
    margin: "0 auto",
    width:
      "calc(\n    100% -\n    var(--dsh-composer-side-clearance) -\n    var(--dsh-composer-side-clearance) -\n    var(--dsh-composer-dock-inset) -\n    var(--dsh-composer-dock-inset) -\n    var(--dsh-composer-dock-inset) -\n    var(--dsh-composer-dock-inset)\n  )",
    maxWidth:
      "calc(\n    var(--dsh-composer-card-max-width) -\n    var(--dsh-composer-dock-inset) -\n    var(--dsh-composer-dock-inset) -\n    var(--dsh-composer-dock-inset) -\n    var(--dsh-composer-dock-inset)\n  )",
    border: "0.5px solid var(--dsw-alias-border-l1)",
    borderRadius: "12px",
    background: "var(--dsw-specific-tip)",
    "--dsh-scrollbar-thumb": "var(--dsw-alias-scrollbar-bg-l2)",
    "--dsh-scrollbar-thumb-hover": "var(--dsw-alias-scrollbar-hover-l2)",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "6px 12px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "0",
    border: "none",
    background: "transparent",
    textAlign: "left",
    cursor: "pointer",
  },
  lead: {
    display: "grid",
    flex: "none",
    placeItems: "center",
    color: "var(--dsw-alias-label-tertiary)",
  },
  title: {
    flex: "none",
    fontSize: "13px",
    lineHeight: "24px",
    fontWeight: "500",
    color: "var(--dsw-alias-label-primary)",
  },
  progress: {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    fontSize: "13px",
    lineHeight: "20px",
    fontWeight: "400",
    color: "var(--dsw-alias-label-tertiary)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: {
    display: "grid",
    flex: "none",
    placeItems: "center",
    color: "var(--dsw-alias-label-tertiary)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    margin: "0",
    padding: "0",
    listStyle: "none",
    maxHeight: "180px",
    overflowY: "auto",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minWidth: "0",
    fontSize: "13px",
    lineHeight: "20px",
    color: "var(--dsw-alias-label-secondary)",
  },
  glyph: {
    display: "grid",
    flex: "none",
    placeItems: "center",
    width: "16px",
    height: "16px",
  },
  glyphCompleted: {
    color: "var(--dsw-alias-state-success-primary)",
  },
  glyphPending: {
    color: "var(--dsw-alias-label-caption)",
  },
  glyphProgress: {
    color: "var(--dsw-alias-state-business-primary)",
    animation: "todo-progress-spin 1s linear infinite",
  },
  content: {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "todo-progress-spin": {
    to: {
      transform: "rotate(360deg)",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;
