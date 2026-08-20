import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const REGISTRY = "https://npm.pkg.github.com/"

// turbo 在每个包自己的目录下运行本脚本，只处理当前包
const { name, version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string
  version: string
}

const view = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry", REGISTRY], {
  encoding: "utf8",
})
if (view.status === 0) {
  console.log(`skip ${name}: ${version} already published`)
  process.exit(0)
}
if (!view.stderr.includes("E404")) {
  process.stderr.write(view.stderr)
  process.exit(1)
}

console.log(`to publish: ${name}@${version}`)
const publish = spawnSync("pnpm", ["publish", "--access=public", "--registry", REGISTRY], {
  stdio: "inherit",
})
if (publish.status !== 0) process.exit(publish.status ?? 1)
