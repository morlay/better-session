import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  text: {
    margin: "0",
    color: "var(--dsw-alias-label-secondary)",
    font: "inherit",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  fields: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    margin: "8px 0 0",
    paddingTop: "8px",
    borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  },
  field: {
    display: "flex",
    gap: "8px",
    minWidth: "0",
  },
  fieldKey: {
    flex: "none",
    minWidth: "96px",
    color: "var(--dsw-alias-label-caption)",
  },
  fieldValue: {
    flex: "1 1 auto",
    minWidth: "0",
    margin: "0",
    color: "var(--dsw-alias-label-tertiary)",
    overflowWrap: "anywhere",
  },
  files: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px 12px",
    margin: "0 0 8px",
    padding: "0",
    listStyle: "none",
  },
  file: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    minWidth: "0",
  },
  filePath: {
    color: "var(--dsw-alias-label-secondary)",
    overflowWrap: "anywhere",
  },
  fileAction: {
    color: "var(--dsw-alias-label-caption)",
  },
  catalogNotice: {
    margin: "0 0 6px",
    color: "var(--dsw-alias-label-caption)",
  },
  entries: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    margin: "0",
    padding: "0",
    listStyle: "none",
  },
  entry: {
    display: "flex",
    gap: "8px",
    minWidth: "0",
  },
  entryName: {
    flex: "none",
    color: "var(--dsw-alias-label-secondary)",
  },
  entryDescription: {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    color: "var(--dsw-alias-label-tertiary)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sections: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    margin: "0",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "0",
  },
  sectionName: {
    color: "var(--dsw-alias-label-caption)",
  },
  sectionText: {
    margin: "0",
    color: "var(--dsw-alias-label-secondary)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  relaySender: {
    margin: "0 0 6px",
    color: "var(--dsw-alias-label-caption)",
    overflowWrap: "anywhere",
  },
  recalls: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    margin: "0 0 8px",
    padding: "0",
    listStyle: "none",
  },
  recall: {
    display: "flex",
    gap: "8px",
    minWidth: "0",
  },
  recallLabel: {
    color: "var(--dsw-alias-label-secondary)",
    overflowWrap: "anywhere",
  },
  recallCounts: {
    flex: "none",
    color: "var(--dsw-alias-label-caption)",
  },
} satisfies Record<string, CSSProps>;
