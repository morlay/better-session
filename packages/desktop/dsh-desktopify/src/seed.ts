import type { Stats } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROFILE_NAME } from "./appconfig.ts";

export const SEED_DIR_NAME = "dsh-home";

export const SEED_HASH_NAME = ".seed-hash";

/** Seed-relative directory holding the immutable runtime: the host's dsh installation and the Web frontend. */
export const SEED_RUNTIME_DIR_NAME = "runtime";

const SEED_SKIP_DIRS = new Set([".nub-store", ".store", ".nub"]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readSeedHash(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureSeedProfile(seedDir: string, home: string): Promise<boolean> {
  const seedProfile = join(seedDir, "profiles", PROFILE_NAME);
  if (!(await isDirectory(seedProfile))) return false;
  const profileDir = join(home, "profiles", PROFILE_NAME);
  const seedHash = await readSeedHash(join(seedProfile, SEED_HASH_NAME));
  if (seedHash !== "") {
    try {
      const stat = await lstat(profileDir);
      if (
        !stat.isSymbolicLink() &&
        (await readSeedHash(join(profileDir, SEED_HASH_NAME))) === seedHash
      ) {
        return false;
      }
    } catch {}
  }
  try {
    const stat = await lstat(profileDir);
    if (stat.isSymbolicLink()) await unlink(profileDir);
    else if (stat.isDirectory()) await rm(profileDir, { recursive: true });
    else await unlink(profileDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copySeed(seedProfile, profileDir);
  return true;
}

/**
 * Plant one profile subtree. The seed's runtime lives beside the profile and stays in the
 * application's read-only resources, so only `profiles/<name>` is copied into the home.
 */
async function copySeed(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const destination = join(target, ...relativePath.split("/"));
      if (entry.isSymbolicLink()) {
        if (await pathExists(destination)) continue;
        await mkdir(dirname(destination), { recursive: true });
        await symlink(
          await readlink(path),
          destination,
          process.platform === "win32" ? "junction" : "dir",
        );
        continue;
      }
      let stat: Stats;
      try {
        stat = await lstat(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (SEED_SKIP_DIRS.has(entry.name)) continue;
        await mkdir(destination, { recursive: true });
        await visit(path, relativePath);
        continue;
      }
      if (!stat.isFile() || (await pathExists(destination))) continue;
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(path, destination);
      await chmod(destination, stat.mode & 0o777);
    }
  };
  await visit(source, "");
}
