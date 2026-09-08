import p from "dsh-custom-next/package.json" with { type: "json" };
import { join } from "path";
import { $ } from "zx";

async function main(cwd = process.cwd()) {
  const dshHomeDir = join(cwd, ".dsh-store");

  for (const pkg in p.dependencies) {
    await $`DSH_HOME=${dshHomeDir} dsh plugin --profile web add ${pkg}@${resolveAsLink(pkg)}`.pipe(
      process.stdout,
    );
  }

  const port = process.env.PORT ?? "3080";

  await $`DSH_HOME=${dshHomeDir} NODE_OPTIONS=--import=tsx/esm dsh web --port=${port}`.pipe(
    process.stdout,
  );
}

function resolveAsLink(pkg: string): string {
  return `link:${join(import.meta.resolve(pkg).slice("file://".length).split("/src/index")[0]!)}`;
}

await main();
