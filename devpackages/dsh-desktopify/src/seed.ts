/**
 * Packaged profile seed: the bundle step writes the workspace profile into
 * `dsh-home/profiles/desktop` beside the shell executable — package.json,
 * cordis.patch.yml, the declared `files` entries, and a real copy of the
 * production dependency closure as `node_modules` (the upstream desktop host
 * resolves its own entry and every profile bundle inside the project
 * directory, so links to the app closure would fail its containment check).
 * The seed is stamped with a `.seed-hash` fingerprint of the workspace
 * content. At startup the shell forces the runtime home's profile to be a
 * real copy of that seed: a mismatched fingerprint (or a stale symlink)
 * replaces the profile, a matching fingerprint skips the copy so the closure
 * is not re-copied on every launch. User data lives at the home root and is
 * never touched by profile replacement.
 * @module @morlay/dsh-desktopify
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { PROFILE_NAME } from "./appconfig.ts";

/** Seed directory name beside the shell executable. */
export const SEED_DIR_NAME = "dsh-home";

/** Fingerprint file name inside the seeded profile. */
export const SEED_HASH_NAME = ".seed-hash";

/** Directories skipped when copying the seed (installation bookkeeping). */
const SEED_SKIP_DIRS = new Set([".nub-store", ".store", ".nub"]);

function readSeedHash(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Force the runtime home's profile to a real copy of the packaged seed.
 * @param seedDir - packaged seed root (`<exeDir>/../dsh-home`).
 * @param home - resolved runtime `DSH_HOME`.
 * @returns whether the profile was (re)written.
 */
export function ensureSeedProfile(seedDir: string, home: string): boolean {
  const seedProfile = join(seedDir, "profiles", PROFILE_NAME);
  if (!isDirectory(seedProfile)) return false;
  const profileDir = join(home, "profiles", PROFILE_NAME);
  const seedHash = readSeedHash(join(seedProfile, SEED_HASH_NAME));
  if (seedHash !== "") {
    try {
      const stat = lstatSync(profileDir);
      if (!stat.isSymbolicLink() && readSeedHash(join(profileDir, SEED_HASH_NAME)) === seedHash) {
        return false;
      }
    } catch {
      // Missing profile: fall through to the copy.
    }
  }
  try {
    const stat = lstatSync(profileDir);
    if (stat.isSymbolicLink()) unlinkSync(profileDir);
    else if (stat.isDirectory()) rmSync(profileDir, { recursive: true });
    else unlinkSync(profileDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  copySeed(seedDir, home);
  return true;
}

/**
 * Copy the seed into the home, skipping bookkeeping directories and never
 * overwriting user data. The seed's node_modules is a self-contained pnpm
 * isolated layout (real copies in `.pnpm`, relative links everywhere else),
 * so symlinks are recreated as-is — dereferencing would break the layout.
 */
function copySeed(seedDir: string, home: string): void {
  mkdirSync(home, { recursive: true });
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const target = join(home, relative(seedDir, source));
      if (entry.isSymbolicLink()) {
        // 保留链接原样：种子闭包自包含（相对链接指向 .pnpm 副本）。
        if (existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(
          readlinkSync(source),
          target,
          process.platform === "win32" ? "junction" : "dir",
        );
        continue;
      }
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(source);
      } catch {
        continue; // Broken entry inside the seed: skip.
      }
      if (stat.isDirectory()) {
        if (SEED_SKIP_DIRS.has(entry.name)) continue;
        mkdirSync(target, { recursive: true });
        visit(source);
        continue;
      }
      if (!stat.isFile() || existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      chmodSync(target, stat.mode & 0o777);
    }
  };
  visit(seedDir);
}
