import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

export interface PreparedIcons {
  readonly mac?: string;

  readonly linux?: string;

  readonly win?: string;
}

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

const CONTAIN_BACKGROUND = { r: 0, g: 0, b: 0, alpha: 0 };

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function prepareIcons(
  workspace: string,
  buildRootDir: string,
  icon: string | undefined,
): Promise<PreparedIcons> {
  if (icon === undefined || icon === "") return {};
  const source = resolve(workspace, icon);
  if (!(await pathExists(source))) {
    throw new Error(`desktop bundle: workspace icon ${source} does not exist`);
  }
  const outDir = join(buildRootDir, "icon");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const png512 = join(outDir, "icon-512.png");
  await sharp(source)
    .resize(512, 512, { fit: "contain", background: CONTAIN_BACKGROUND })
    .png()
    .toFile(png512);
  let icons: PreparedIcons = { linux: png512, win: png512 };
  if (process.platform === "darwin") {
    const iconset = join(outDir, "icon.iconset");
    await mkdir(iconset, { recursive: true });
    for (const [size, name] of MAC_ICONSET_SIZES) {
      await sharp(source)
        .resize(size, size, { fit: "contain", background: CONTAIN_BACKGROUND })
        .png()
        .toFile(join(iconset, name));
    }
    const icns = join(outDir, "icon.icns");
    await promisify(execFile)("iconutil", ["-c", "icns", iconset, "-o", icns]);
    icons = { ...icons, mac: icns };
  }
  await writeFile(join(outDir, "icon.json"), `${JSON.stringify(icons, undefined, 2)}\n`);
  return icons;
}
