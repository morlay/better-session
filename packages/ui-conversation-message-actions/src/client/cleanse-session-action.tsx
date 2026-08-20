/**
 * 会话头部「清洗会话」入口。
 *
 * 仅当会话历史加载失败（会话 snapshot 的 `openState === "error"`）时渲染：
 * 点击调用服务端 cleanse,把该会话的 sourceEventSeqs / surfaceOp /
 * shadowedRange 坐标一次性重写为稠密空间,成功后客户端 resync 重新加载
 * 历史。注入面来自 `SessionEditorFace`(hooks → `useSessionEditor`,
 * 方法 → `cleanse`)。
 */

import { useCallback, useState, type ReactElement } from "react";
import { Button, IconRefreshOutline16 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionEditorState } from "./controller.ts";

export interface CleanseSessionActionProps {
  /** inject hooks：订阅 sessionEditor 状态。 */
  useSessionEditor: <S>(sel: (s: SessionEditorState) => S) => S;
  /** inject face：发起清洗。 */
  cleanse: () => Promise<boolean>;
}

/**
 * 历史加载失败时显示「清洗会话」按钮。
 * @param props - 注入的 selector 钩子与清洗方法。
 * @returns 按钮元素；会话未处于错误状态时返回 null。
 */
export function CleanseSessionAction({
  useSessionEditor,
  cleanse,
}: CleanseSessionActionProps): ReactElement | null {
  const openError = useSessionEditor((s) => s.sessionOpenError);
  const cleansing = useSessionEditor((s) => s.pending === "cleanse");
  const [busy, setBusy] = useState(false);
  const onClick = useCallback(() => {
    setBusy(true);
    void cleanse().finally(() => setBusy(false));
  }, [cleanse]);
  if (!openError) return null;
  const working = busy || cleansing;
  return (
    <Button
      variant="outline"
      size="sm"
      icon={<IconRefreshOutline16 />}
      onClick={onClick}
      disabled={working}
      title="清洗会话：把 provenance 坐标重写为稠密空间，修复历史加载失败"
    >
      {working ? "清洗中…" : "清洗会话"}
    </Button>
  );
}
