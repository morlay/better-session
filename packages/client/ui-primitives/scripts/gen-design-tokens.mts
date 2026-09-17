import { glob, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const THEME_ROOT = join(REPO_ROOT, "vendor/deepseek-harness/packages/client/ui-theme/src");
const OUT = join(import.meta.dirname, "../src/client/theme.generated.ts");

const files = [
  ...(await Array.fromAsync(glob("styles/**/*.css", { cwd: THEME_ROOT }))).sort(),
  ...(await Array.fromAsync(glob("**/*.ts", { cwd: THEME_ROOT }))).sort(),
].sort(
  (a, b) => Number(b.endsWith("design-platform.css")) - Number(a.endsWith("design-platform.css")),
);

const defaults = new Map<string, string>();
for (const file of files) {
  const text = await readFile(join(THEME_ROOT, file), "utf8");
  for (const match of text.matchAll(/--dsw-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:\s*([^;{}]+);/g)) {
    if (!defaults.has(match[1]!)) defaults.set(match[1]!, match[2]!.trim());
  }
}

const names = new Set(defaults.keys());

function toPath(name: string): string[] {
  return name.split("-");
}

function toName(path: readonly string[]): string {
  return path.join("-");
}

type Tree = { [key: string]: Tree | string };

function setToken(root: Tree, path: readonly string[]): void {
  let node = root;
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1;
    const existing = node[segment];
    if (last) {
      if (existing === undefined) node[segment] = defaults.get(path.join("-")) ?? "true";
      else (existing as Tree)["$"] = defaults.get(path.join("-")) ?? "true";
      continue;
    }
    if (existing === undefined) node[segment] = {};
    else if (typeof existing === "string") node[segment] = { $: existing };
    node = node[segment] as Tree;
  }
}

const tree: Tree = {};
for (const name of [...names].sort()) {
  const path = toPath(name);
  if (toName(path) !== name)
    throw new Error(`token 往返不自洽：${name} → ${path.join(".")} → ${toName(path)}`);
  setToken(tree, path);
}

function render(node: Tree, depth: number): string {
  const pad = "  ".repeat(depth);
  const lines = Object.entries(node).map(([key, value]) =>
    typeof value === "string"
      ? `${pad}  ${JSON.stringify(key)}: ${JSON.stringify(value)},`
      : `${pad}  ${JSON.stringify(key)}: {\n${render(value, depth + 2)}\n${pad}  },`,
  );
  return lines.join("\n");
}

const body = `/**
 * 官方主题的 \`--dsw-*\` token 全集（${names.size} 个），由 packages/client/ui-primitives/scripts/gen-design-tokens.mts 生成，勿手改。
 *
 * 叶子是该变量的**默认值**（官方 light 主题里首次出现的定义）：既是类型推导的来源，也可作 fallback。
 * \`"$"\` 键出现在「自身也是 token 的分支」上（命名体系里有 40 个短名同时是长名前缀的 token）。
 * 消费时只需树形状——\`Token.vars()\` 生成 \`var(--dsw-…)\`，不重新定义变量。
 * 漂移、往返与默认值完整性由 src/__tests__/design-tokens.spec.ts 守卫。 */
export const designTokens = {
${render(tree, 0)}
} as const
`;

await writeFile(OUT, body);
console.log(`生成 ${names.size} 个 token → ${OUT}`);
