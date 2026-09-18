import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, protocol, session } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { loadAppConfig, PROFILE_NAME, type AppConfig } from "./appconfig.ts";
import { installDesktopDirectoryPicker } from "./directory-picker.ts";
import { resolveDshHome } from "./dshhome.ts";
import { DesktopHostProcess } from "./host-process.ts";
import { DESKTOP_IPC, SCHEME, assertDesktopSender } from "./ipc.ts";
import { ensureSeedProfile } from "./seed.ts";
import { shellWrappedSpawn } from "./shell-env.ts";
import { authenticateWebHost, forwardWebRequest, serveWebDocument } from "./web-document.ts";

let focusPrimaryWindow = (): void => {};

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

const WEB_FRONTEND_PACKAGE = "@deepseek-ai/dsh-web-frontend";

const APPLICATION_URL = `${SCHEME}://app/`;

const LOCAL_DOCUMENT_PATHS = ["/favicon.svg", "/manifest.webmanifest"];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isLocalDocumentPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.startsWith("/assets/") ||
    LOCAL_DOCUMENT_PATHS.includes(pathname)
  );
}

interface RuntimeResources {
  readonly node: string;
  readonly seed: string;
  readonly primaryRuntime: string;
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
  const configured = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR;
  const primaryRuntime =
    configured !== undefined && configured !== ""
      ? resolve(configured)
      : join(process.resourcesPath, "runtime", "primary-runtime");
  return { node, seed, primaryRuntime };
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

function windowFrame(): Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "frame" | "titleBarOverlay"
> {
  if (process.platform === "darwin") return { titleBarStyle: "hidden" };
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: "#888888" },
    };
  }
  return { frame: false };
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
    ...windowFrame(),
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
    const destination = new URL(url);
    const current = new URL(window.webContents.getURL());
    if (
      destination.protocol !== `${SCHEME}:` &&
      !(destination.protocol === "http:" && destination.origin === current.origin)
    )
      event.preventDefault();
  });
  return window;
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

function developmentNodeArgs(): string[] {
  const specifier = process.env.DSH_DESKTOP_TSX_IMPORT;
  return specifier === undefined || specifier === "" ? [] : [`--import=${specifier}`];
}

async function main(): Promise<void> {
  const development = developmentProject();
  const config: AppConfig =
    development === undefined
      ? await loadAppConfig(process.resourcesPath)
      : await loadAppConfig(process.env.DSH_DESKTOP_APPCONFIG_DIR ?? process.resourcesPath);
  const resources = runtimeResources();
  const hostInspectPort = developmentHostInspectPort(development !== undefined);
  const activeProject = development ?? join(resolveDshHome(config) ?? "", "profiles", PROFILE_NAME);

  const runtimeProject = development ?? join(resources.seed, "profiles", PROFILE_NAME);
  const webDocumentRoot = join(
    runtimeProject,
    "node_modules",
    ...WEB_FRONTEND_PACKAGE.split("/"),
    "dist",
  );
  const dshHome = resolveDshHome(config);

  if (development === undefined) {
    if (dshHome === undefined)
      throw new Error("dsh desktop: packaged applications require a concrete dshHome");
    await ensureSeedProfile(resources.seed, dshHome);
  }
  if (!(await pathExists(join(webDocumentRoot, "index.html")))) {
    throw new Error(
      `dsh desktop: the Web frontend is missing at ${webDocumentRoot}; ` +
        `the runtime closure must carry ${WEB_FRONTEND_PACKAGE}`,
    );
  }

  let host: DesktopHostProcess | undefined;
  let hostUrl: string | undefined;
  let hostCookie: string | undefined;
  let injections: readonly unknown[] = [];
  let mainWindow: BrowserWindow | undefined;
  let quitConfirmed = false;
  let quitPrompting = false;
  const appPreload = fileURLToPath(new URL("./preload-app.cjs", import.meta.url));

  const confirmQuit = async (window?: BrowserWindow): Promise<void> => {
    if (quitPrompting) return;
    quitPrompting = true;
    try {
      const options = {
        type: "question" as const,
        buttons: ["Cancel", "Quit"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: `Quit ${config.name}?`,
        detail: "The desktop backend and its running sessions will stop.",
      };
      const parent = window ?? mainWindow;
      const { response } =
        parent === undefined || parent.isDestroyed()
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(parent, options);
      if (response !== 1) return;
      quitConfirmed = true;
      app.quit();
    } finally {
      quitPrompting = false;
    }
  };

  const startHost = async (projectDir = activeProject): Promise<DesktopHostProcess> => {
    const next = new DesktopHostProcess(
      resources.node,
      runtimeProject,
      projectDir,
      hostInspectPort,
      {
        nodeArgs: development === undefined ? [] : developmentNodeArgs(),

        extraEnv: {
          ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
          ...(development === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
        },
        primaryRuntime: resources.primaryRuntime,
        profileResolution: development === undefined ? "runtime" : "link",
        spawn: shellWrappedSpawn,
      },
    );
    const ready = await next.start();
    hostCookie = await authenticateWebHost(ready.url);
    hostUrl = ready.url;
    if (ready.injections === undefined)
      throw new Error("dsh desktop: Host did not provide boot injections");
    injections = ready.injections;
    return next;
  };

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return Promise.resolve(new Response(null, { status: 404 }));
    if (isLocalDocumentPath(url.pathname)) return serveWebDocument(request, webDocumentRoot);
    if (host === undefined || hostUrl === undefined || hostCookie === undefined)
      return Promise.resolve(new Response(null, { status: 503 }));
    return forwardWebRequest(request, hostUrl, hostCookie);
  });

  installDesktopDirectoryPicker(() => mainWindow);

  ipcMain.handle(DESKTOP_IPC.boot, (event) => {
    assertDesktopSender(event, ["app"]);
    if (host === undefined || hostUrl === undefined)
      throw new Error("dsh desktop: Host is unavailable");
    return { injections, streamBaseUrl: new URL(hostUrl).origin };
  });

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ["app"]);
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame)
      throw new Error("dsh desktop: rejected startup failure from a non-primary frame");
    if (typeof message !== "string") throw new Error("dsh desktop: startup failure must be text");
    console.error(new Error(message));
  });

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["ws://127.0.0.1/*"] },
    (details, callback) => {
      if (
        hostUrl === undefined ||
        hostCookie === undefined ||
        details.webContentsId !== mainWindow?.webContents.id
      ) {
        callback({});
        return;
      }
      const target = new URL(hostUrl);
      const requested = new URL(details.url);
      if (requested.host !== target.host) {
        callback({});
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      );
      if (headers.origin !== `${SCHEME}://app`) {
        callback({ cancel: true });
        return;
      }
      callback({
        requestHeaders: {
          ...headers,
          origin: target.origin,
          cookie: hostCookie,
          "sec-fetch-site": "same-origin",
        },
      });
    },
  );

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, config.window);
    mainWindow = window;
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on("close", (event) => {
      if (quitConfirmed) return;
      event.preventDefault();
      void confirmQuit(window);
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
      void replacement.loadURL(APPLICATION_URL);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  host = await startHost();

  mainWindow = createMainWindow();
  await mainWindow.loadURL(APPLICATION_URL);
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
    if (!quitConfirmed) {
      event.preventDefault();
      void confirmQuit();
      return;
    }
    if (host === undefined) return;
    event.preventDefault();
    const active = host;
    host = undefined;
    void active
      .stop()
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => {
        app.quit();
      });
  });
}

if (app.isPackaged) {
  try {
    // 打包应用必须在 whenReady 之前把 userData 指到 appconfig.json 的 id 目录；
    // 这里用顶层 await 完成读配置与建目录，模块其余部分随后继续同步执行。
    const profile = join(app.getPath("appData"), (await loadAppConfig(process.resourcesPath)).id);
    await mkdir(profile, { recursive: true });
    app.setPath("userData", profile);
  } catch (error) {
    console.error(error);
  }
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
