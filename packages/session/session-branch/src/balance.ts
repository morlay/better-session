import type { SessionEvent } from "@deepseek-ai/dsh-session";

export function balanceRewindPrefix(events: readonly SessionEvent[]): SessionEvent[] {
  let keep = events.length;
  // 从尾部向前待配对的 step/end 数（每个配对它之前的 step/start）。
  let openStepEnds = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === "turn/end") break; // 轮次闭合：之前的 step 全部配对。
    if (type === "step/end") {
      openStepEnds += 1;
      continue;
    }
    if (type === "step/start") {
      if (openStepEnds > 0) {
        openStepEnds -= 1; // 配对成功。
      } else {
        keep = index; // 孤儿 step/start：剔除它及其后。
      }
    }
  }
  return events.slice(0, keep);
}
