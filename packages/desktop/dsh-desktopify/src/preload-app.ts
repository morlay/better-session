import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC, SCHEME } from "./ipc.ts";

if (location.protocol === `${SCHEME}:` && location.hostname === "app") {
  contextBridge.exposeInMainWorld("__DSH_DIRECTORY_PICKER__", {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  });
  contextBridge.exposeInMainWorld("dshDesktopBoot", {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) =>
      ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  });
}

contextBridge.exposeInMainWorld("dshDesktop", { protocolVersion: 1 });
