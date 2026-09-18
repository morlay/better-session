import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import {
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from "@deepseek-ai/dsh-client-ui-primitives";

const PANEL_MARGIN = 12;

const PANEL_GAP = 8;

export const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

export interface StatDialogSeat {
  open: boolean;
  setOpen: (open: boolean) => void;
  rootRef: MutableRefObject<HTMLSpanElement | null>;
  panelRef: MutableRefObject<HTMLDivElement | null>;
  pos: CSSProperties | null;
}

export function useStatDialog(
  controlled?: Pick<StatDialogSeat, "open" | "setOpen">,
): StatDialogSeat {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled?.open ?? ownOpen;
  const setOpen = controlled?.setOpen ?? setOwnOpen;
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: "top",
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  });

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);

  return { open, setOpen, rootRef, panelRef, pos };
}
