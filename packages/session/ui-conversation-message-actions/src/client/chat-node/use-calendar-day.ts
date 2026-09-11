// Component-local calendar-day tick: memoized message rows keep stable props
// across midnight, so the IconActions clock needs a local day seat that
// re-fires at the next local midnight without reaching for framework hooks.

import { useEffect, useState } from "react";
import { msUntilNextLocalMidnight, startOfLocalDay } from "./message-chrome.ts";

export function useCalendarDay(): number {
  const [day, setDay] = useState(() => startOfLocalDay(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      const now = Date.now();
      setDay(startOfLocalDay(now));
      timer = setTimeout(arm, msUntilNextLocalMidnight(now));
    };
    timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()));
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return day;
}
