import { useRef, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { EditableMessageBlock } from "../../shared.ts";
import css from "./MessageEditDialog.module.css";

const BLOCK_TITLE: Record<EditableMessageBlock["kind"], string> = {
  user: "编辑用户消息",
  "assistant.reasoning": "编辑助手思考",
  "assistant.response": "编辑助手回复",
};

export function MessageEditDialog({
  block,
  onSave,
  onClose,
}: {
  block: EditableMessageBlock;
  onSave: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState(block.text);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const autosize = (): void => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const save = (): void => {
    if (saving) return;
    setSaving(true);
    void onSave(text).then((applied) => {
      if (applied) onClose();
      else setSaving(false);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={BLOCK_TITLE[block.kind]}
      closeLabel="关闭"
      footer={
        <div className={css.actions}>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      }
    >
      <textarea
        ref={inputRef}
        className={css.input}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          autosize();
        }}
        autoFocus
        rows={4}
      />
    </Modal>
  );
}
