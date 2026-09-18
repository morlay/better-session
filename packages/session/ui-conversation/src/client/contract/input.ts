/**
 * fork 的输入契约扩宽：上游 `contract/input.ts` 是**同一声明实例**（我们没复制它），
 * 这里只加 fork 多出来的面。上游那些声明继续从 vendor 源引用，两边的跨包比较因此
 * 落在同一份类型上，不会出现「结构相同但是两条类型实例」的失败。
 *
 * 为什么不直接对 vendor 模块做 augmentation：`dts` 打包会把上游那份声明**内联**进
 * 我们的产物（内联的是未扩宽的那一份），augmentation 只会作为一条悬空的 `declare
 * module` 留下 —— 发布出去的类型面反而丢了扩宽。显式声明在这里，产物里的类型面就
 * 和运行期一致。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  InputActions as UpstreamInputActions,
  SessionInput as UpstreamSessionInput,
  SessionInputResolver as UpstreamSessionInputResolver,
} from "../../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/input.ts";

/** 会话输入面：上游那份加上 fork 的草稿还原入口。 */
export interface SessionInput extends UpstreamSessionInput {
  /** 把草稿整段换成纯文本（不重建引用出现项）。 */
  restoreDraft(draft: string): void;
}

/** 会话寻址的输入解析器：`for` 收窄到带 `restoreDraft` 的那份 facade。 */
export interface SessionInputResolver extends Omit<UpstreamSessionInputResolver, "for"> {
  for(actx: Context): SessionInput;
}

/** 公共输入动作面：同样带上草稿还原。 */
export interface InputActions extends UpstreamInputActions {
  /** 把草稿整段换成纯文本（不重建引用出现项）。 */
  restoreDraft(draft: string): void;
}
