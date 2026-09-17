import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSeedProfile, SEED_DIR_NAME, SEED_HASH_NAME } from "../seed.ts";

const roots: string[] = [];

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function write(path: string, content = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

interface Fixture {
  readonly seed: string;
  readonly home: string;
  readonly seedProfile: string;
  readonly homeProfile: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-seed-"));
  roots.push(root);
  const seed = join(root, SEED_DIR_NAME);
  const home = join(root, "home");
  const seedProfile = join(seed, "profiles", "desktop");
  await write(join(seedProfile, SEED_HASH_NAME), "abc123");
  await write(join(seedProfile, "cordis.patch.yml"), "- insert: []\n");
  return { seed, home, seedProfile, homeProfile: join(home, "profiles", "desktop") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("seed profile planting", () => {
  it("plants the profile into an empty app home", async () => {
    const { seed, home, homeProfile } = await fixture();

    expect(await ensureSeedProfile(seed, home)).toBe(true);
    expect(await readFile(join(homeProfile, "cordis.patch.yml"), "utf8")).toBe("- insert: []\n");
    expect(await readFile(join(homeProfile, SEED_HASH_NAME), "utf8")).toBe("abc123");
  });

  it("leaves a matching profile alone on the next launch", async () => {
    const { seed, home, homeProfile } = await fixture();
    await ensureSeedProfile(seed, home);
    await write(join(homeProfile, "local-state.json"), "{}\n");

    expect(await ensureSeedProfile(seed, home)).toBe(false);
    expect(await readFile(join(homeProfile, "local-state.json"), "utf8")).toBe("{}\n");
  });

  it("replaces the profile when the seed fingerprint changes", async () => {
    const { seed, home, homeProfile, seedProfile } = await fixture();
    await ensureSeedProfile(seed, home);
    await write(join(homeProfile, "stale.json"), "{}\n");

    await write(join(seedProfile, SEED_HASH_NAME), "def456");
    await write(join(seedProfile, "extra.json"), "{}\n");

    expect(await ensureSeedProfile(seed, home)).toBe(true);
    expect(await exists(join(homeProfile, "stale.json"))).toBe(false);
    expect(await exists(join(homeProfile, "extra.json"))).toBe(true);
    expect(await readFile(join(homeProfile, SEED_HASH_NAME), "utf8")).toBe("def456");
  });

  it("re-plants when the seed carries no fingerprint", async () => {
    const { seed, home, seedProfile } = await fixture();
    await rm(join(seedProfile, SEED_HASH_NAME));

    expect(await ensureSeedProfile(seed, home)).toBe(true);
    expect(await ensureSeedProfile(seed, home)).toBe(true);
  });

  it("does nothing when the seed has no desktop profile", async () => {
    const { seed, home } = await fixture();
    await rm(join(seed, "profiles"), { recursive: true });

    expect(await ensureSeedProfile(seed, home)).toBe(false);
    expect(await exists(home)).toBe(false);
  });

  it("keeps symlinks as links and skips the store directories", async () => {
    const { seed, home, homeProfile, seedProfile } = await fixture();
    await write(join(seed, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await symlink(join("..", "..", "node_modules", "pkg"), join(seedProfile, "pkg-link"), "dir");
    await write(join(seedProfile, ".store", "cached.txt"), "cached\n");

    expect(await ensureSeedProfile(seed, home)).toBe(true);
    expect((await lstat(join(homeProfile, "pkg-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(homeProfile, "pkg-link"))).toBe(
      join("..", "..", "node_modules", "pkg"),
    );
    expect(await exists(join(homeProfile, ".store"))).toBe(false);
  });
});
