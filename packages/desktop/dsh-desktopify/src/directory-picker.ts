import { dialog, ipcMain, type BrowserWindow } from "electron";
import { DESKTOP_IPC, assertDesktopSender } from "./ipc.ts";

export function installDesktopDirectoryPicker(getWindow: () => BrowserWindow | undefined): void {
  const pending = new WeakMap<BrowserWindow, Promise<string | null>>();
  ipcMain.handle(DESKTOP_IPC.directoryPick, async (event) => {
    const window = getWindow();
    if (
      window === undefined ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error("dsh desktop: rejected directory picker from an unowned renderer");
    }
    assertDesktopSender(event, ["app"]);
    const existing = pending.get(window);
    if (existing !== undefined) return existing;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    const result = dialog
      .showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })
      .then(({ canceled, filePaths }) =>
        window.isDestroyed() || canceled ? null : (filePaths[0] ?? null),
      )
      .finally(() => {
        pending.delete(window);
      });
    pending.set(window, result);
    return result;
  });
}
