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
    maxWidth: "min(525px, 82%)",
  },
  bubble: {
    maxWidth: "100%",
    background: "var(--dsw-specific-bubble)",
    borderRadius: "22px",
    padding: "10px 16px",
    fontSize: "16px",
    lineHeight: "24px",
    color: "var(--dsw-alias-label-primary)",
  },
  contextRow: {
    padding: "2px 0",
  },
  compactionRow: {
    padding: "2px 0",
  },
  compactionButton: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: "24px",
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
    "&:not(:disabled):hover .compactionContextIcon": {
      opacity: "0",
    },
    "&:not(:disabled):focus-visible .compactionContextIcon": {
      opacity: "0",
    },
    "&:not(:disabled):hover .compactionDisclosureIcon": {
      opacity: "1",
    },
    "&:not(:disabled):focus-visible .compactionDisclosureIcon": {
      opacity: "1",
    },
  },
  compactionLeading: {
    flex: "none",
    display: "inline-grid",
    placeItems: "center",
    width: "16px",
    height: "16px",
    marginRight: "6px",
    color: "var(--dsw-alias-label-secondary)",
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
    fontSize: "14px",
    lineHeight: "24px",
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
    fontSize: "14px",
    lineHeight: "24px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  compactionBody: {
    padding: "4px 0 4px 22px",
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "14px",
    lineHeight: "24px",
  },
  retryRow: {
    color: "var(--dsw-alias-label-tertiary)",
    fontSize: "13px",
    lineHeight: "20px",
    "&[data-active] .retryText": {
      background:
        "linear-gradient(\n    90deg,\n    var(--dsw-alias-label-tertiary) 0%,\n    var(--dsw-alias-label-tertiary) 40%,\n    var(--dsw-alias-label-secondary) 50%,\n    var(--dsw-alias-label-tertiary) 60%,\n    var(--dsw-alias-label-tertiary) 100%\n  )",
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
    "&[open] .retrySummary::after": {
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
      content: '""',
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
    fontSize: "12px",
    lineHeight: "18px",
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
    fontSize: "13px",
    lineHeight: "20px",
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
  refChip: {
    display: "inline-block",
    margin: "0 2px",
    padding: "0 8px",
    borderRadius: "6px",
    background: "rgba(97, 135, 216, 0.22)",
    color: "var(--dsw-alias-label-primary)",
    fontSize: "0.85em",
    lineHeight: "1.6",
    whiteSpace: "nowrap",
    verticalAlign: "baseline",
  },
  confirmActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
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
