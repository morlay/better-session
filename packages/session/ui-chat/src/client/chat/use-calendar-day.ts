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
