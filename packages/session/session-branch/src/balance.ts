import type { SessionEvent } from "@deepseek-ai/dsh-session";

export interface BalanceRewindPrefixOptions {
  // 导出 / 导入的是整段日志：尾部未闭合的 step/start 是中断运行的正常形状，交给上游 resume 补 closers；
  // rewind / fork 之后会紧接着追加新的 step/start，悬空的旧 step/start 会让它报错，必须一并丢弃。
  keepOpenTail?: boolean;
}

// 保留前缀配平：每个 step/start 必须与同 turn/step 的 step/end 成对。日志已不平衡（step/end 无配对、
// step/start 撞未闭合）时从配平点起丢弃尾部（自愈），否则下游 token-meter 折叠会报 step/end 无配对。
export function balanceRewindPrefix(
  events: readonly SessionEvent[],
  options: BalanceRewindPrefixOptions = {},
): SessionEvent[] {
  let keep = events.length;
  let openIndex = -1;
  let open: { turn: number; step: number } | undefined;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === "step/start") {
      if (open !== undefined) {
        keep = index;
        break;
      }
      open = { turn: event.data.turn, step: event.data.step };
      openIndex = index;
      continue;
    }
    if (event.type === "step/end") {
      if (open === undefined || open.turn !== event.data.turn || open.step !== event.data.step) {
        keep = index;
        break;
      }
      open = undefined;
      openIndex = -1;
    }
  }

  if (options.keepOpenTail !== true && open !== undefined) keep = Math.min(keep, openIndex);
  return events.slice(0, keep);
}

// rewind 只按 seq 读尾部窗口（`types` 是窗口内升序的事件类型），在窗口上做同样的配对修剪：
// 从尾部往回扫，遇到 turn/end 即停（它之前的内容与保留前缀的尾部无关）；尾部未闭合的
// step/start 一并丢弃，避免它之后的追加（重放的新 step）撞上未闭合的旧 step。
// 调用方必须保证窗口覆盖到「最近一个 turn/end」或前缀开头，否则结果不完整。
export function rewindKeepLength(types: readonly string[], rawKeepLength: number): number {
  let relativeKeep = types.length;
  let openStepEnds = 0;
  for (let index = types.length - 1; index >= 0; index -= 1) {
    const type = types[index];
    if (type === "turn/end") break;
    if (type === "step/end") {
      openStepEnds += 1;
      continue;
    }
    if (type === "step/start") {
      if (openStepEnds > 0) openStepEnds -= 1;
      else relativeKeep = index;
    }
  }
  return Math.max(0, rawKeepLength - types.length + relativeKeep);
}
