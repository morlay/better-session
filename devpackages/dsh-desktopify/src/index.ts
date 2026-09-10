/**
 * Electron shell: window, `dsh-app://` custom protocol, and the dsh backend
 * child lifecycle. The backend is the upstream `@deepseek-ai/dsh-desktop-host`
 * entry run under a bundled Node.js executable (packaged) or the current
 * Electron executable in node mode (development); requests from the renderer
 * are forwarded over framed byte pipes. On Unix the backend inherits the
 * user's shell environment through rc sourcing (see shell-env.ts).
 * @module @morlay/dsh-desktopify
 */

import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, protocol } from "electron";
import { loadAppConfig, PROFILE_NAME, type AppConfig } from "./appconfig.ts";
import { resolveDshHome } from "./dshhome.ts";
import { DesktopHostProcess } from "./host-process.ts";
import { ensureSeedProfile } from "./seed.ts";
import { shellWrappedSpawn } from "./shell-env.ts";

const SCHEME = "dsh-app";
let focusPrimaryWindow = (): void => {};

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  },
]);

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Runtime resources resolved for the current mode. */
interface RuntimeResources {
  readonly node: string;
  readonly seed: string;
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged;
  const node =
    (development ? process.env.DSH_DESKTOP_NODE_BINARY : undefined) ??
    join(
      process.resourcesPath,
      "runtime",
      "node",
      process.platform === "win32" ? "node.exe" : "node",
    );
  const seed =
    (development ? process.env.DSH_DESKTOP_SEED_DIR : undefined) ??
    join(process.resourcesPath, "seed");
  return { node, seed };
}

function developmentProject(): string | undefined {
  const configured = process.env.DSH_DESKTOP_DEV_PROJECT_DIR;
  if (configured === undefined || configured === "") return undefined;
  if (app.isPackaged)
    throw new Error(
      "dsh desktop: development project override is unavailable in packaged applications",
    );
  return resolve(configured);
}

function createWindow(
  preload: string,
  config: { width: number; height: number; minWidth: number; minHeight: number },
): BrowserWindow {
  const window = new BrowserWindow({
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).protocol !== `${SCHEME}:`) event.preventDefault();
  });
  return window;
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const root = resolve(app.getAppPath(), "renderer");
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  const target = resolve(normalize(join(root, pathname)));
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 });
  try {
    const body = request.method === "HEAD" ? null : await readFile(target);
    return new Response(body, {
      headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT;
  if (!enabled || configured === undefined || configured === "") return undefined;
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535",
    );
  }
  return port;
}

async function main(): Promise<void> {
  const development = developmentProject();
  const config: AppConfig =
    development === undefined
      ? loadAppConfig(process.resourcesPath)
      : loadAppConfig(process.env.DSH_DESKTOP_APPCONFIG_DIR ?? process.resourcesPath);
  const resources = runtimeResources();
  const hostInspectPort = developmentHostInspectPort(development !== undefined);
  const activeProject = development ?? join(resolveDshHome(config) ?? "", "profiles", PROFILE_NAME);
  const dshHome = resolveDshHome(config);

  if (development === undefined) {
    if (dshHome === undefined)
      throw new Error("dsh desktop: packaged applications require a concrete dshHome");
    ensureSeedProfile(resources.seed, dshHome);
  }

  let host: DesktopHostProcess | undefined;
  let mainWindow: BrowserWindow | undefined;
  const appPreload = fileURLToPath(new URL("./preload-app.cjs", import.meta.url));

  const startHost = async (projectDir = activeProject): Promise<DesktopHostProcess> => {
    const next = new DesktopHostProcess(resources.node, projectDir, hostInspectPort, {
      nodeArgs: development === undefined ? [] : ["--import=tsx/esm"],
      // 显式设置 DSH_HOME：用户 shell 环境可能残留旧应用的 DSH_HOME
      // export，host 经 shell 注入启动时会继承它，导致数据落到错误目录。
      extraEnv: {
        ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
        ...(development === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      },
      spawn: shellWrappedSpawn,
    });
    await next.start();
    return next;
  };

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname === "shell") return serveShellAsset(request);
    if (url.hostname !== "app") return Promise.resolve(new Response(null, { status: 404 }));
    const active = host;
    if (active === undefined)
      return Promise.resolve(new Response("backend unavailable", { status: 503 }));
    return active.fetch(request);
  });

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, config.window);
    mainWindow = window;
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = undefined;
    });
    return window;
  };
  focusPrimaryWindow = () => {
    const window = mainWindow;
    if (window === undefined || window.isDestroyed()) {
      const replacement = createMainWindow();
      void replacement.loadURL(`${SCHEME}://app/index.html`);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  // 先启动 host 再加载页面：页面首帧即拿到后端（官方实现同序）。
  host = await startHost();

  mainWindow = createMainWindow();
  await mainWindow.loadURL(`${SCHEME}://app/index.html`);
  if (development !== undefined && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== "0") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow();
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  app.on("before-quit", (event) => {
    if (host === undefined) return;
    event.preventDefault();
    const active = host;
    host = undefined;
    void active.stop().finally(() => {
      app.quit();
    });
  });
}

const ownsDesktopInstance = ((): boolean => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    focusPrimaryWindow();
  });
  return true;
})();

if (ownsDesktopInstance)
  void app
    .whenReady()
    .then(main)
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE;
      if (diagnosticFile !== undefined) {
        await import("node:fs/promises")
          .then((fs) =>
            fs.writeFile(
              diagnosticFile,
              `${error instanceof Error ? (error.stack ?? message) : message}\n`,
            ),
          )
          .catch(() => undefined);
      }
      dialog.showErrorBox("dsh desktop startup failed", message);
      app.exit(1);
    });
