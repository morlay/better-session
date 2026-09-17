import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  userRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "6px",
  },
  userStack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "8px",
    minWidth: "0",
    maxWidth: "min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)",
  },
  bubble: {
    maxWidth: "100%",
    background: "var(--dsw-specific-bubble)",
    borderRadius: "22px",
    padding: "10px 16px",
    fontSize: "var(--dsh-content-font-size, 14px)",
    lineHeight: "calc(22px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-primary)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  referenceSummary: {
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(18px + var(--dsh-content-font-delta-secondary, 0px))",
  },
  contextRow: {
    padding: "2px 0",
  },
  compactionRow: {
    "--dsh-compaction-header-height": "calc(24px + var(--dsh-content-font-delta, 0px))",
    padding: "2px 0",
    "&:has([data-compaction-body]) [data-compaction-button]": {
      position: "sticky",
      top: "0",
      zIndex: "7",
      borderRadius: "0",
      background: "var(--dsw-alias-bg-base)",
    },
    "&:has([data-compaction-body]) [data-compaction-button]:hover": {
      background: "var(--dsw-alias-interactive-bg-hover-solid)",
    },
  },
  compactionButton: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: "var(--dsh-compaction-header-height)",
    minWidth: "0",
    padding: "0",
    border: "none",
    borderRadius: "6px",
    background: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    "&:not(:disabled)": {
      cursor: "pointer",
    },
    "&:not(:disabled):hover": {
      background: "var(--dsw-alias-interactive-bg-hover)",
    },
    "&:not(:disabled):hover [data-compaction-context-icon]": {
      opacity: "0",
    },
    "&:not(:disabled):focus-visible [data-compaction-context-icon]": {
      opacity: "0",
    },
    "&:not(:disabled):hover [data-compaction-disclosure-icon]": {
      opacity: "1",
    },
    "&:not(:disabled):focus-visible [data-compaction-disclosure-icon]": {
      opacity: "1",
    },
  },
  compactionBody: {
    "& :has(> [data-code-block-banner])": {
      top: "var(--dsh-compaction-header-height)",
    },
    padding: "4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
  },
  compactionLeading: {
    flex: "none",
    display: "inline-grid",
    placeItems: "center",
    width: "calc(16px + var(--dsh-content-font-delta, 0px))",
    height: "calc(16px + var(--dsh-content-font-delta, 0px))",
    marginRight: "6px",
    color: "var(--dsw-alias-label-secondary)",
    "& svg": {
      width: "calc(14px + var(--dsh-content-font-delta, 0px))",
      height: "calc(14px + var(--dsh-content-font-delta, 0px))",
    },
  },
  compactionContextIcon: {
    display: "inline-flex",
    gridArea: "1 / 1",
    alignItems: "center",
    justifyContent: "center",
  },
  compactionDisclosureIcon: {
    display: "inline-flex",
    gridArea: "1 / 1",
    alignItems: "center",
    justifyContent: "center",
    opacity: "0",
  },
  compactionTitle: {
    flex: "none",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    color: "var(--dsw-alias-label-primary-dimmed)",
  },
  compactionSep: {
    flex: "none",
    width: "2px",
    height: "2px",
    margin: "0 8px",
    borderRadius: "1px",
    background: "var(--dsw-alias-label-caption)",
  },
  compactionSummary: {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  retryRow: {
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
    "&[data-active] [data-retry-text]": {
      background:
        "linear-gradient(\n      90deg,\n      var(--dsw-alias-label-tertiary) 0%,\n      var(--dsw-alias-label-tertiary) 40%,\n      var(--dsw-alias-label-secondary) 50%,\n      var(--dsw-alias-label-tertiary) 60%,\n      var(--dsw-alias-label-tertiary) 100%\n    )",
      backgroundPosition: "100% 50%",
      backgroundSize: "200% 100%",
      backgroundClip: "text",
      color: "transparent",
      animation: "retry-shimmer 1.6s ease-in-out infinite",
      "@media (prefers-reduced-motion: reduce)": {
        background: "none",
        color: "inherit",
        animation: "none",
      },
    },
    "&[open] [data-retry-summary]::after": {
      transform: "rotate(45deg)",
    },
  },
  retrySummary: {
    display: "inline-flex",
    alignItems: "center",
    width: "fit-content",
    padding: "2px 0",
    gap: "7px",
    borderRadius: "3px",
    color: "inherit",
    cursor: "pointer",
    listStyle: "none",
    userSelect: "none",
    "&::-webkit-details-marker": {
      display: "none",
    },
    "&::after": {
      width: "6px",
      height: "6px",
      borderRight: "1.5px solid currentcolor",
      borderBottom: "1.5px solid currentcolor",
      content: "''",
      opacity: "0.8",
      transform: "rotate(-45deg)",
      transition: "transform 120ms ease",
    },
    "&:hover": {
      color: "var(--dsw-alias-label-secondary)",
    },
    "&:focus-visible": {
      outline: "1.5px solid var(--dsw-alias-button-info-fill)",
      outlineOffset: "2px",
    },
  },
  retryText: {
    color: "inherit",
  },
  retryDetails: {
    display: "grid",
    gap: "2px",
    marginTop: "3px",
    paddingLeft: "14px",
    overflowWrap: "anywhere",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(18px + var(--dsh-content-font-delta-secondary, 0px))",
  },
  retryDetailLabel: {
    color: "var(--dsw-alias-label-secondary)",
  },
  turnErrorRow: {
    display: "grid",
    gridTemplateColumns: "10px minmax(0, 1fr) auto",
    gap: "8px",
    alignItems: "start",
    padding: "2px 0",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  },
  turnErrorDot: {
    marginTop: "5px",
  },
  turnErrorCopy: {
    minWidth: "0",
    overflowWrap: "anywhere",
  },
  turnErrorTitle: {
    marginRight: "6px",
    color: "var(--dsw-alias-state-error-primary)",
    fontWeight: "600",
  },
  turnErrorMessage: {
    color: "var(--dsw-alias-label-secondary)",
  },
  turnErrorCode: {
    color: "var(--dsw-alias-label-tertiary)",
    font: "var(--dsw-font-markdown-code-block-small)",
  },
  maxTokensTitle: {
    marginRight: "6px",
    color: "var(--dsw-alias-state-warn-primary)",
    fontWeight: "600",
  },
  attachmentRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: "100%",
    gap: "8px",
  },
  fileCard: {
    display: "inline-flex",
    flex: "0 0 240px",
    alignItems: "center",
    gap: "10px",
    width: "240px",
    minHeight: "64px",
    padding: "8px 12px",
    border: "0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))",
    borderRadius: "16px",
    background: "var(--dsw-specific-input-major, transparent)",
    boxSizing: "border-box",
  },
  fileIcon: {
    flex: "none",
    width: "28px",
    height: "28px",
  },
  fileContent: {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    minWidth: "0",
  },
  fileName: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    color: "var(--dsw-alias-label-primary)",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "22px",
  },
  fileMeta: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    color: "var(--dsw-alias-label-tertiary, rgba(0, 0, 0, 0.45))",
    fontSize: "12px",
    lineHeight: "15px",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "retry-shimmer": {
    from: {
      backgroundPosition: "100% 50%",
    },
    to: {
      backgroundPosition: "0 50%",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;
