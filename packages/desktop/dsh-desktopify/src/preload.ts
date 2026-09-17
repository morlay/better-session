import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("dshDesktop", { protocolVersion: 1 });
