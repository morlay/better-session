import p from "dsh-custom-next/package.json" with { type: "json" };
import { dirname, join } from "path";
import { existsSync } from "fs";
import { $ } from "zx";

async function main(cwd = process.cwd()) {
  const dshHomeDir = join(cwd, ".dsh-store");

  const plugins = [];

  for (const pkg in p.dependencies) {
    plugins.push(`${pkg}@${resolveAsLink(pkg)}`);
  }

  // `dsh plugin add` 一次接受一个插件参数；多个拼进一个参数会被当单个
  // dependency 值写入 profile package.json（畸形 link），所以逐个添加。
  for (const plugin of plugins) {
    await $`DSH_HOME=${dshHomeDir} dsh plugin --profile web add ${plugin}`.pipe(
      process.stdout,
    );
  }

  const port = process.env.PORT ?? "3080";

  await $`DSH_HOME=${dshHomeDir} NODE_OPTIONS=--import=tsx/esm dsh web --port=${port}`.pipe(
    process.stdout,
  );
}

/** 解析包导出到源码文件后向上找 package.json，得到包根目录作为 link 目标。 */
function resolveAsLink(pkg: string): string {
  const entry = import.meta.resolve(pkg).slice("file://".length).split("?")[0]!;
  let dir = dirname(entry);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const parent = dirname(dir);
    if (existsSync(join(dir, "package.json"))) break;
    if (parent === dir) throw new Error(`cannot locate package root for ${pkg} from ${entry}`);
    dir = parent;
  }
  return `link:${dir}`;
}

await main();
