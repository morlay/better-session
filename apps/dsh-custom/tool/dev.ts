import p from "dsh-custom-next/package.json" with { type: "json" };
import { join } from "path";
import { $ } from "zx";

async function main(cwd = process.cwd()) {
  const dshHomeDir = join(cwd, ".dsh-store");

  const plugins = [];

  for (const pkg in p.dependencies) {
    plugins.push(`${pkg}@${resolveAsLink(pkg)}`);
  }

  if (plugins.length > 0) {
    await $`DSH_HOME=${dshHomeDir} dsh plugin --profile web add ${plugins.join(" ")}`.pipe(
      process.stdout,
    );
  }

  await $`DSH_HOME=${dshHomeDir} NODE_OPTIONS=--import=tsx/esm dsh web`.pipe(process.stdout);
}

function resolveAsLink(pkg: string): string {
  return `link:${join(import.meta.resolve(pkg).slice("file://".length).split("src")[0]!)}`;
}

await main();
