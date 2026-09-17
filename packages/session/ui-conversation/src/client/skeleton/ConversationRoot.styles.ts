import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minWidth: "0",
    background: "var(--dsw-alias-bg-base)",
    "--dsh-chat-content-width":
      "var(\n    --dsh-chat-user-width,\n    clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px)\n  )",
    "--dsh-composer-card-max-width": "calc(var(--dsh-chat-content-width) + 32px)",
    "--dsh-composer-side-clearance": "16px",
    "--dsh-composer-dock-inset": "8px",
    "&:has([data-conversation-composer-overlay]) [data-width-handle]": {
      display: "none",
    },
    "&[data-phase='active']": {
      overflow: "hidden",
    },
    "&[data-phase='active'] [data-conversation-header]": {
      flex: "none",
    },
    "&[data-phase='active'] [data-view-area]": {
      flex: "1 0 auto",
      minHeight: "auto",
    },
    "&[data-phase='active'] [data-composer-seat]": {
      position: "sticky",
      bottom: "0",
      zIndex: "7",
      background:
        "linear-gradient(\n    180deg,\n    color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px,\n    var(--dsw-alias-bg-base) 36px\n  )",
    },
    "&[data-phase='active'] [data-composer-seat]:has([data-trigger-menu])": {
      zIndex: "9",
    },
    "&[data-phase='hero'] [data-conversation-scroll]": {
      justifyContent: "center",
      overflowY: "auto",
    },
    "&[data-phase='settling'] [data-composer-seat]": {
      visibility: "hidden",
    },
  },
  header: {
    flex: "none",
    boxSizing: "border-box",
    minHeight: "76px",
    padding: "10px 28px 0 20px",
    borderBottom: "0.5px solid var(--dsw-alias-border-l3)",
  },
  headerHidden: {
    display: "none",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "0",
    minHeight: "30px",
  },
  titleCluster: {
    display: "flex",
    flex: "1",
    alignItems: "center",
    gap: "10px",
    minWidth: "0",
  },
  crumbs: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
    overflow: "hidden",
    whiteSpace: "nowrap",
  },
  crumbSeg: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
  },
  crumbSep: {
    color: "var(--dsw-alias-label-caption)",
    fontSize: "14px",
    lineHeight: "20px",
  },
  crumb: {
    maxWidth: "220px",
    overflow: "hidden",
    padding: "4px 8px",
    border: "none",
    borderRadius: "12px",
    background: "transparent",
    fontSize: "14px",
    lineHeight: "20px",
    color: "var(--dsw-alias-label-tertiary)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    cursor: "pointer",
    "&:hover:not(:disabled)": {
      background: "var(--dsw-alias-interactive-bg-hover)",
    },
  },
  crumbSubagent: {
    fontSize: "12px",
    lineHeight: "18px",
  },
  crumbCurrent: {
    fontWeight: "500",
    color: "var(--dsw-alias-label-primary)",
    cursor: "default",
  },
  headerActions: {
    display: "flex",
    flex: "none",
    alignItems: "center",
    gap: "8px",
  },
  headerUtilities: {
    display: "flex",
    flex: "none",
    alignItems: "center",
    gap: "8px",
    marginLeft: "20px",
    "&:empty": {
      display: "none",
    },
  },
  headerCorner: {
    display: "flex",
    flex: "none",
    alignItems: "center",
    marginLeft: "8px",
    marginRight: "-16px",
    "&:empty": {
      display: "none",
    },
  },
  tabs: {
    position: "relative",
    zIndex: "1",
    display: "flex",
    gap: "36px",
    marginTop: "10px",
    paddingLeft: "8px",
  },
  tab: {
    position: "relative",
    padding: "0 0 9px",
    border: "none",
    background: "transparent",
    fontSize: "13px",
    lineHeight: "16px",
    fontWeight: "500",
    color: "var(--dsw-alias-label-tertiary)",
    cursor: "pointer",
    "&::after": {
      content: "''",
      position: "absolute",
      right: "0",
      bottom: "-1px",
      left: "0",
      height: "2px",
      borderRadius: "2px",
      background: "transparent",
    },
  },
  tabActive: {
    color: "var(--dsw-alias-state-business-primary)",
    "&::after": {
      background: "var(--dsw-alias-state-business-primary)",
    },
  },
  viewArea: {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    minHeight: "0",
  },
  widthHandle: {
    position: "absolute",
    top: "0",
    bottom: "0",
    zIndex: "8",
    width:
      "min(\n    40px,\n    calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px)\n  )",
    cursor: "col-resize",
    "&[data-side='left']": {
      right: "calc(50% + var(--dsh-chat-content-width) / 2 + 24px)",
    },
    "&[data-side='right']": {
      left: "calc(50% + var(--dsh-chat-content-width) / 2 + 24px)",
    },
    "&::after": {
      content: "''",
      position: "absolute",
      top: "0",
      bottom: "0",
      width: "3px",
      borderRadius: "3px",
      background:
        "linear-gradient(\n    to bottom,\n    transparent calc(var(--dsh-width-handle-pointer-y, 50%) - 52px),\n    var(--dsw-alias-scrollbar-hover-l1) calc(var(--dsh-width-handle-pointer-y, 50%) - 12px),\n    var(--dsw-alias-scrollbar-hover-l1) calc(var(--dsh-width-handle-pointer-y, 50%) + 12px),\n    transparent calc(var(--dsh-width-handle-pointer-y, 50%) + 52px)\n  )",
      opacity: "0",
      pointerEvents: "none",
    },
    "&[data-side='left']::after": {
      right: "16px",
    },
    "&[data-side='right']::after": {
      left: "16px",
    },
    "&:hover::after": {
      opacity: "1",
    },
    "&[data-dragging]::after": {
      opacity: "1",
    },
  },
  composerStack: {
    "--dsh-composer-stack-gap": "6px",
    display: "flex",
    flexDirection: "column",
    gap: "var(--dsh-composer-stack-gap)",
  },
  composerSeat: {
    display: "flex",
    flex: "none",
    flexDirection: "column",
    "--dsh-composer-text-max-height": "336px",
  },
  body: {
    position: "relative",
    display: "flex",
    flex: "1",
    flexDirection: "column",
    minHeight: "0",
  },
  scrollBody: {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    minHeight: "0",
    marginRight: "2px",
    overflowY: "auto",
    scrollbarGutter: "stable",
    "&::-webkit-scrollbar-track": {
      margin: "2px",
    },
    "&:has([data-conversation-composer-overlay])": {
      position: "relative",
      overflowX: "hidden",
      overflowY: "auto",
      scrollbarGutter: "auto",
    },
    "&:has([data-conversation-composer-overlay]) > :global([data-slot='conversation.session']) > [data-view-area]":
      {
        flex: "1 1 0",
        minHeight: "0",
        overflow: "hidden",
      },
    "&:has([data-conversation-composer-overlay]) > [data-composer-seat]": {
      position: "absolute",
      right: "var(--dsh-scrollbar-width)",
      bottom: "0",
      left: "0",
    },
  },
  composerHero: {
    alignSelf: "center",
    gap: "8px",
    paddingBottom: "32px",
    width:
      "min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%)",
    zIndex: "1",
  },
  heroWorkspaceRow: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    minWidth: "0",
    marginTop: "4px",
    padding: "0 16px 0 20px",
  },
} satisfies Record<string, CSSProps>;
