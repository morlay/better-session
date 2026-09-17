import type { CSSProps } from "@morlay/dsh-client-ui-primitives/client";

export const styles = {
  slot: {
    position: "sticky",
    top: "0",
    zIndex: "7",
    height: "0",
    pointerEvents: "none",
    "@container (max-width: 900px)": {
      display: "none",
    },
  },
  frame: {
    "--turn-rail-band":
      "calc(\n    var(--dsh-conversation-viewport-height, 100dvh) - var(--dsh-composer-height, 152px)\n  )",
    "--turn-preview-height": "100px",
    position: "absolute",
    top: "calc(var(--turn-rail-band) / 2)",
    right: "calc(12px - (var(--dsh-composer-side-clearance) + 16px))",
    width: "28px",
    height:
      "min(\n    var(--turn-natural-height),\n    max(0px, calc(var(--turn-rail-band) - 64px)),\n    420px\n  )",
    cursor: "pointer",
    pointerEvents: "auto",
    transform: "translateY(-50%)",
    transition: "height 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
      animation: "none",
      scrollBehavior: "auto",
    },
  },
  scroller: {
    position: "absolute",
    inset: "0",
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarWidth: "none",
    "&::-webkit-scrollbar": {
      display: "none",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
      animation: "none",
      scrollBehavior: "auto",
    },
  },
  fadeTop: {
    maskImage: "linear-gradient(to bottom, transparent 0, #000 24px, #000 100%)",
  },
  fadeBottom: {
    maskImage: "linear-gradient(to bottom, #000 0, #000 calc(100% - 24px), transparent 100%)",
  },
  fadeTopFadeBottom: {
    maskImage:
      "linear-gradient(\n    to bottom,\n    transparent 0,\n    #000 24px,\n    #000 calc(100% - 24px),\n    transparent 100%\n  )",
  },
  marks: {
    position: "relative",
    height: "var(--turn-natural-height)",
  },
  markPosition: {
    position: "absolute",
    top: "calc(var(--turn-natural-position) + var(--turn-rail-inset))",
    right: "0",
    left: "0",
    height: "10px",
    transform: "translateY(-50%)",
    transition: "top 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    animation: "dsh-turn-mark-enter 150ms ease-out",
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
      animation: "none",
      scrollBehavior: "auto",
    },
  },
  mark: {
    position: "absolute",
    inset: "0 0 0 auto",
    width: "20px",
    padding: "0",
    border: "0",
    borderRadius: "8px",
    background: "transparent",
    cursor: "pointer",
    pointerEvents: "none",
    "&::before": {
      position: "absolute",
      top: "50%",
      right: "0",
      width: "12px",
      height: "2px",
      borderRadius: "2px",
      background: "var(--dsw-alias-border-l4)",
      content: "''",
      transform: "translateY(-50%)",
      transition: "width 140ms ease, background-color 140ms ease",
      "@media (prefers-reduced-motion: reduce)": {
        transition: "none",
        animation: "none",
        scrollBehavior: "auto",
      },
    },
    "&:focus-visible::before": {
      width: "20px",
      background: "var(--dsw-alias-state-business-primary)",
    },
    "&:focus-visible": {
      outline: "1px solid var(--dsw-alias-state-business-primary)",
      outlineOffset: "2px",
    },
  },
  markUnloaded: {
    "&::before": {
      width: "8px",
      opacity: "0.6",
    },
  },
  markPreview: {
    "&::before": {
      width: "18px",
      background: "var(--dsw-alias-label-tertiary)",
    },
  },
  markBusy: {
    "&::before": {
      animation: "dsh-turn-mark-busy 1s ease-in-out infinite",
      "@media (prefers-reduced-motion: reduce)": {
        transition: "none",
        animation: "none",
        scrollBehavior: "auto",
      },
    },
  },
  markActive: {
    "&::before": {
      width: "20px",
      background: "var(--dsw-alias-label-primary)",
    },
  },
  preview: {
    position: "absolute",
    top: "clamp(\n    0px,\n    calc(\n      var(--turn-natural-position) + var(--turn-rail-inset)\n      - var(--turn-scroll-top, 0px) - var(--turn-preview-height) / 2\n    ),\n    calc(100% - var(--turn-preview-height))\n  )",
    right: "calc(100% + 10px)",
    boxSizing: "border-box",
    width: "min(300px, calc(100cqw - 120px))",
    maxHeight: "var(--turn-preview-height)",
    overflow: "hidden",
    padding: "10px 12px",
    border: "0",
    borderRadius: "10px",
    color: "var(--dsw-alias-label-primary)",
    background: "var(--dsw-alias-bg-layer-1)",
    boxShadow: "var(--dsw-elevation-panel)",
    pointerEvents: "none",
    animation: "dsh-turn-preview-enter 120ms ease-out",
    transition: "top 140ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
      animation: "none",
      scrollBehavior: "auto",
    },
  },
  previewPrompt: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    font: "var(--dsw-font-xs-strong-13)",
    WebkitLineClamp: "1",
  },
  previewResponse: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    marginTop: "4px",
    color: "var(--dsw-alias-label-caption)",
    font: "var(--dsw-font-xxs-12)",
    WebkitLineClamp: "3",
  },
} satisfies Record<string, CSSProps>;

export const animations = {
  "dsh-turn-mark-enter": {
    from: {
      opacity: "0",
    },
    to: {
      opacity: "1",
    },
  },
  "dsh-turn-preview-enter": {
    from: {
      opacity: "0",
      transform: "translateX(4px)",
    },
    to: {
      opacity: "1",
      transform: "translateX(0)",
    },
  },
  "dsh-turn-mark-busy": {
    "0%,\n  100%": {
      opacity: "1",
    },
    "50%": {
      opacity: "0.35",
    },
  },
} satisfies Record<string, Record<string, CSSProps>>;
