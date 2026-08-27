/**
 * rewind 保留前缀的平衡化：把截断后残留的未配对 step/start 从尾部剔除。
 *
 * 真实 agent-loop 的 append 顺序是 `turn/start → step/start → user/message →
 * ...`（step/start 在 user/message **之前**）。rewind 到 user/message 边界
 * （exclusive——drop 该消息及其后）时，保留前缀会以**未配对的 step/start**
 * 结尾：它的 step/end 落在 drop 区。token meter 重放要求每个 step/start 都有
 * 配对的 step/end（`step/start` 未闭合时遇到下一个 `step/start` 会抛
 * "arrived before turn ... ended"），因此保留前缀必须平衡化——从尾部剔除
 * 未配对的 step/start，使截断后的 log 对任何重放者（token meter / 派生 /
 * 续写）都合法。
 *
 * 本函数是契约层共享纯函数：rdb 的 `rewind`（决定 RDB 删除目标）与编排层
 * （cold 续写的 seq 计算）都基于它，保证「保留前缀」在两层完全一致。
 *
 * @module @morlay/session-branch/balance
 */

import type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * 从尾部剔除未配对的 `step/start`，返回平衡后的保留前缀。
 *
 * 从尾部向前扫描：`step/end` 配对它**之前**的 `step/start`（agent-loop 的
 * finally 保证每个 step/start 都有配对 step/end，除非被 rewind 截断）；
 * `turn/end` 闭合其轮次，之前的 step 全部合法。未配对（孤儿）的
 * `step/start` 及其后全部剔除——rewind 截断产生的孤儿只可能出现在保留
 * 前缀的尾部（drop 区是后缀），因此从尾部剔除即完整修复。
 *
 * 只剔除**尾部**未配对的 step/start：log 中间（闭合轮次之间）的 step/start
 * 必然有配对，且剔除中间事件会破坏 seq 连续性。
 * @param events - rewind 的保留前缀（截断后、未平衡）。
 * @returns 平衡后的保留前缀（原数组的尾部切片；不修改入参）。
 */
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
