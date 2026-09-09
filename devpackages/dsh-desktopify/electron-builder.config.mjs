/**
 * electron-builder configuration for the static, unsigned desktop bundle.
 * `--dir` produces an unpacked application directory (macOS `.app`, Linux
 * directory, Windows directory) without code signing, notarization, or
 * installer artifacts — no developer account required. The backend runtime
 * (bundled Node.js) and the profile seed ride as `extraResources`.
 *
 * The workspace is read from `DSH_DESKTOP_WORKSPACE` (the CLI forwards its
 * positional argument there) and defaults to the current directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// electron-builder 以 CJS 动态 import 加载本配置，import.meta.dirname 在
// 该加载方式下指向 apps/（配置文件的上一级）——用 process.cwd() 定位
// 包根（bundle.ts 在包目录内执行 electron-builder）。

/** Read the workspace `dsh.desktop` identity for the packaged application. */
function workspaceDesktopConfig() {
  const configured = process.env.DSH_DESKTOP_WORKSPACE;
  const workspace = resolve(
    configured !== undefined && configured.trim() !== "" ? configured : process.cwd(),
  );
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  const desktop = manifest.dsh?.desktop ?? {};
  return {
    workspace,
    name: manifest.name ?? "dsh-desktop-app",
    id: desktop.id ?? "ai.deepseek.dsh.custom",
    version: manifest.version ?? "0.0.1",
    window: desktop.window ?? {},
    icon: desktop.icon,
    dshHome: desktop.dshHome ?? "xdg",
  };
}

const desktop = workspaceDesktopConfig();
const BUILD_ROOT = join(desktop.workspace, "node_modules", ".dsh-desktopify");
console.log(
  `desktop bundle: workspace config name=${desktop.name} id=${desktop.id} dshHome=${desktop.dshHome}`,
);

/** Prepared platform icons (written by the bundle step's prepareIcons). */
function preparedIcons() {
  const path = join(BUILD_ROOT, "icon", "icon.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

const icons = preparedIcons();

export default {
  appId: desktop.id,
  productName: desktop.name,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  directories: { output: join(BUILD_ROOT, "artifacts") },
  asar: true,
  files: ["lib/*.js", "lib/*.cjs", "renderer/**/*", "package.json"],
  extraResources: [
    { from: join(BUILD_ROOT, "runtime"), to: "runtime" },
    { from: join(BUILD_ROOT, "seed"), to: "seed" },
    { from: join(BUILD_ROOT, "runtime", "appconfig.json"), to: "appconfig.json" },
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
  publish: null,
};
