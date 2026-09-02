import { useCallback, useRef, useState, type ReactElement } from "react";
import { Button, IconProps } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionEditorState } from "./controller.ts";

export interface SessionImportActionProps {
  useSessionEditor: <S>(sel: (s: SessionEditorState) => S) => S;

  importSession: (file: File) => Promise<boolean>;
}

export const IconUpload = ({ size = 14, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M12 3v12" />
    <path d="m17 8-5-5-5 5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </svg>
);

export function SessionImportAction({
  useSessionEditor,
  importSession,
}: SessionImportActionProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const importing = useSessionEditor((s) => s.pending === "import");
  const error = useSessionEditor((s) => s.error);
  const [busy, setBusy] = useState(false);

  const onPick = useCallback(
    (file: File | undefined) => {
      if (file === undefined) return;
      setBusy(true);
      void importSession(file).finally(() => setBusy(false));
    },
    [importSession],
  );

  const working = busy || importing;
  return (
    <>
      <Button
        size="sm"
        icon={<IconUpload />}
        disabled={working}
        aria-busy={working}
        aria-label={working ? "导入中…" : "导入会话"}
        title={error ?? "导入会话：用导出的 zip 覆盖当前会话内容"}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            onPick(file);
          }}
        />
      </Button>
    </>
  );
}
