import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    minWidth: "0",
    padding: "0 24px",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "12px",
    width: "100%",
    maxWidth: "var(--dsh-composer-card-max-width)",
    overflow: "visible",
  },
  headline: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: "10px",
    rowGap: "12px",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "26px",
    lineHeight: "32px",
    fontWeight: "500",
    color: "var(--dsw-alias-label-primary)",
  },
  titleGroup: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    columnGap: "7px",
    rowGap: "4px",
    minWidth: "0",
  },
  previewBadge: {
    alignSelf: "flex-start",
    marginTop: "2px",
    padding: "1px 7px 0",
    border: "0.5px solid var(--dsw-alias-interactive-bg-hover)",
    borderRadius: "24px",
    background: "var(--dsw-alias-state-business-tertiary)",
    color: "var(--dsw-alias-label-primary-bluish)",
    fontFamily: "var(--ds-font-family-code)",
    fontSize: "12px",
    lineHeight: "18px",
    fontWeight: "500",
    whiteSpace: "nowrap",
  },
  fishHitbox: {
    display: "inline-flex",
    flex: "none",
    alignItems: "center",
    justifyContent: "center",
    "&:hover .dsh-hero-fish": {
      "@media (hover: hover) and (prefers-reduced-motion: no-preference)": {
        animation: "hero-fish-swim 1.6s ease-in-out infinite",
      },
    },
  },
  fish: {
    display: "block",
    overflow: "visible",
    transformOrigin: "50% 60%",
    color: "var(--dsw-alias-label-primary)",
  },
  body: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    minWidth: "0",
    overflow: "visible",
    "& > *": {
      position: "relative",
      zIndex: "1",
    },
  },
  workspace: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "min(100%, 360px)",
    minHeight: "28px",
    padding: "0 8px",
    border: "none",
    borderRadius: "16px",
    background: "transparent",
    color: "var(--dsw-alias-label-primary)",
    fontSize: "13px",
    lineHeight: "20px",
    fontWeight: "500",
    cursor: "pointer",
    "&:not(:disabled):hover": {
      background: "var(--dsw-alias-interactive-bg-hover)",
    },
    "&[aria-expanded='true']": {
      background: "var(--dsw-alias-interactive-bg-hover)",
    },
    "&:disabled": {
      cursor: "default",
    },
  },
  folder: {
    flex: "none",
    color: "var(--dsw-alias-label-primary)",
  },
  workspaceLabel: {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: {
    flex: "none",
    color: "var(--dsw-alias-label-caption)",
  },
  modalInput: {
    boxSizing: "border-box",
    width: "100%",
    height: "44px",
    padding: "7px 14px",
    border: "0.5px solid var(--dsw-alias-border-l4)",
    borderRadius: "22px",
    outline: "none",
    background: "transparent",
    fontSize: "14px",
    fontWeight: "400",
    lineHeight: "22px",
    color: "var(--dsw-alias-label-primary)",
    "&::placeholder": {
      color: "var(--dsw-alias-label-caption)",
    },
    "&:disabled": {
      color: "var(--dsw-alias-label-dimmed)",
    },
  },
  modalAction: {
    minWidth: "72px",
  },
  modalError: {
    marginTop: "8px",
    fontSize: "12px",
    lineHeight: "18px",
    color: "var(--dsw-alias-state-error-primary)",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "hero-fish-swim": {
    "0%,\n  100%": {
      transform: "none",
    },
    "35%": {
      transform: "rotate(-4deg) translate(-0.4px, -0.9px)",
    },
    "70%": {
      transform: "rotate(1.6deg) translate(0.3px, 0.2px)",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;
