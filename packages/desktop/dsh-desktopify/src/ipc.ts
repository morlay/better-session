import type { IpcMainInvokeEvent } from "electron";

export const DESKTOP_IPC = {
  boot: "dsh-desktop:boot",
  bootFailed: "dsh-desktop:boot-failed",
  directoryPick: "dsh-desktop:directory-pick",
} as const;

export const SCHEME = "dsh-app";

export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame;
  if (senderFrame === null) throw new Error("dsh desktop: rejected IPC without a sender frame");
  const url = new URL(senderFrame.url);
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error("dsh desktop: rejected IPC from an unowned renderer");
  }
}
