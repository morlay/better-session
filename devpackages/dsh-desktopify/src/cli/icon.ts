/**
 * Prepare platform icons from the workspace `dsh.desktop.icon` (an SVG):
 * rasterize with sharp into the sizes each platform needs, and build the
 * macOS `.icns` with `iconutil`. Results are written under the build root's
 * `icon/` directory and summarized in `icon.json` for electron-builder.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

/** Prepared icon paths consumed by electron-builder. */
export interface PreparedIcons {
  /** macOS `.icns` (absent when the platform is not macOS). */
  readonly mac?: string;
  /** Linux 512×512 PNG. */
  readonly linux?: string;
  /** Windows 512×512 PNG (electron-builder converts to `.ico`). */
  readonly win?: string;
}

/** macOS iconset sizes: [pixel, filename]. */
const MAC_ICONSET_SIZES: readonly (readonly [number, string])[] = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

/** Transparent canvas letterboxing（sharp `fit: "contain"` 默认黑底，SVG 上下会透出黑边）。 */
const CONTAIN_BACKGROUND = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Rasterize the workspace icon for the current platform.
 * @param workspace - app workspace directory.
 * @param buildRootDir - the tool's build cache root.
 * @param icon - `dsh.desktop.icon` value (relative to the workspace).
 * @returns the prepared icon paths (empty when no icon is declared).
 */
export async function prepareIcons(
  workspace: string,
  buildRootDir: string,
  icon: string | undefined,
): Promise<PreparedIcons> {
  if (icon === undefined || icon === "") return {};
  const source = resolve(workspace, icon);
  if (!existsSync(source)) {
    throw new Error(`desktop bundle: workspace icon ${source} does not exist`);
  }
  const outDir = join(buildRootDir, "icon");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const png512 = join(outDir, "icon-512.png");
  await sharp(source)
    .resize(512, 512, { fit: "contain", background: CONTAIN_BACKGROUND })
    .png()
    .toFile(png512);
  let icons: PreparedIcons = { linux: png512, win: png512 };
  if (process.platform === "darwin") {
    const iconset = join(outDir, "icon.iconset");
    mkdirSync(iconset, { recursive: true });
    for (const [size, name] of MAC_ICONSET_SIZES) {
      await sharp(source)
        .resize(size, size, { fit: "contain", background: CONTAIN_BACKGROUND })
        .png()
        .toFile(join(iconset, name));
    }
    const icns = join(outDir, "icon.icns");
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
    icons = { ...icons, mac: icns };
  }
  writeFileSync(join(outDir, "icon.json"), `${JSON.stringify(icons, undefined, 2)}\n`);
  return icons;
}
