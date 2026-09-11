/**
 * Electron 壳打包（静态、无签名）：electron-builder 的 `--dir` 语义 —— 产出
 * 未打包的应用目录（macOS `.app` / Linux 目录 / Windows 目录），不做签名、
 * notarize 或安装器，无需开发者账号。后端运行时（随包的 Node.js）与 profile
 * 种子作为 `extraResources` 一起打包。
 *
 * 这里直接调用 electron-builder 的 Node API，壳配置以 TS 收敛在工具内部
 * （不再有独立的 `electron-builder.config.mjs`，也不需要经环境变量回读工作区）。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build, type CliOptions } from "electron-builder";
import type { AppConfig } from "../appconfig.ts";
import type { PreparedIcons } from "./icon.ts";

/**
 * `CliOptions.config` 内嵌的 electron-builder 配置类型。
 * 顶层 `CliOptions.mac/linux/win` 是 CLI 的目标列表（`string[]`），平台配置
 * 只能经 `config` 传入。
 */
type DesktopConfiguration = Exclude<NonNullable<CliOptions["config"]>, string>;

/** 工具 manifest 中随壳 manifest 一起带上的描述字段。 */
interface ToolManifest {
  readonly name?: string;
  readonly description?: string;
  readonly author?: string;
}

/** 一次壳打包所需的全部输入。 */
export interface DesktopBuildOptions {
  /** 工具包根：壳产物（`dist/`）与工具 manifest 的来源。 */
  readonly appRoot: string;
  /** 工具在目标工作区内的构建缓存根。 */
  readonly buildRoot: string;
  /** 壳运行时配置（appId / productName / version 的来源）。 */
  readonly appConfig: AppConfig;
  /** `prepareIcons` 的产物（未声明图标时为空对象）。 */
  readonly icons: PreparedIcons;
  /** 产出未打包的应用目录（等价 CLI `--dir`）。 */
  readonly dir: boolean;
}

/** 已安装 Electron 的版本；本机存在未打包发行版时一并给出（作为打包源）。 */
function installedElectron(): { readonly version: string; readonly dist?: string } {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("electron/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
  if (typeof manifest.version !== "string") {
    throw new Error("dsh-desktopify: installed electron has no version");
  }
  const dist = join(dirname(manifestPath), "dist");
  return { version: manifest.version, ...(existsSync(dist) ? { dist } : {}) };
}

/**
 * electron-builder 的 app 目录：只放运行时文件（`dist/` 壳产物 + 最小
 * manifest）。工具包自身的 package.json 声明了 electron / electron-builder
 * 等构建依赖，而 electron-builder 拒绝把它们当运行时依赖，因此壳以独立
 * 目录打包；app 版本取目标工作区的版本。
 */
function prepareShellAppDirectory(options: DesktopBuildOptions): string {
  const { appRoot, buildRoot, appConfig } = options;
  const appDir = join(buildRoot, "shell");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  cpSync(join(appRoot, "dist"), join(appDir, "dist"), { recursive: true });
  const renderer = join(appRoot, "renderer");
  if (existsSync(renderer)) cpSync(renderer, join(appDir, "renderer"), { recursive: true });
  const tool = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as ToolManifest;
  writeFileSync(
    join(appDir, "package.json"),
    `${JSON.stringify(
      {
        name: tool.name ?? "dsh-desktop-shell",
        version: appConfig.version,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.author === undefined ? {} : { author: tool.author }),
        main: "dist/index.mjs",
      },
      undefined,
      2,
    )}\n`,
  );
  return appDir;
}

/** 打包壳应用，返回 electron-builder 写出的产物路径。 */
export async function buildDesktopApp(options: DesktopBuildOptions): Promise<string[]> {
  const { buildRoot, appConfig, icons, dir } = options;
  const appDir = prepareShellAppDirectory(options);
  const electron = installedElectron();
  console.log(
    `desktop bundle: electron-builder appId=${appConfig.id} productName=${appConfig.name} version=${appConfig.version} electron=${electron.version}`,
  );
  const config: DesktopConfiguration = {
    appId: appConfig.id,
    productName: appConfig.name,
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    electronVersion: electron.version,
    ...(electron.dist === undefined ? {} : { electronDist: electron.dist }),
    directories: { output: join(buildRoot, "artifacts") },
    asar: true,
    files: ["dist/**", "renderer/**/*", "package.json"],
    extraResources: [
      { from: join(buildRoot, "runtime"), to: "runtime" },
      { from: join(buildRoot, "seed"), to: "seed" },
      { from: join(buildRoot, "runtime", "appconfig.json"), to: "appconfig.json" },
    ],
    mac: {
      category: "public.app-category.developer-tools",
      identity: null,
      target: ["dir"],
      ...(icons.mac === undefined ? {} : { icon: icons.mac }),
    },
    linux: {
      category: "Development",
      target: ["dir"],
      ...(icons.linux === undefined ? {} : { icon: icons.linux }),
    },
    win: {
      target: ["dir"],
      ...(icons.win === undefined ? {} : { icon: icons.win }),
    },
  };
  return build({ projectDir: appDir, config, publish: "never", dir });
}
