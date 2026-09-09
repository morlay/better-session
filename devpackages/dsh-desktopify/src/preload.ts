/** Placeholder preload for the shell management surface (unused in the custom shell). */

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("dshDesktop", { protocolVersion: 1 });
