import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, protocol } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
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
  const dshHome = resolveDshHome(config);

  if (development === undefined) {
    if (dshHome === undefined)
      throw new Error("dsh desktop: packaged applications require a concrete dshHome");
    await ensureSeedProfile(resources.seed, dshHome);
  }

  let host: DesktopHostProcess | undefined;
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
        spawn: shellWrappedSpawn,
      },
    );
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
      void replacement.loadURL(`${SCHEME}://app/index.html`);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

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
    if (!quitConfirmed) {
      event.preventDefault();
      void confirmQuit();
      return;
    }
    if (host === undefined) return;
    event.preventDefault();
    const active = host;
    host = undefined;
    void active.stop().finally(() => {
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
