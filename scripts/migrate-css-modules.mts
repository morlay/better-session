/**
 * CSS Modules → css-in-js 样式对象迁移器。
 *
 * 为什么要迁移：样式的目标形态是 css-in-js（`@morlay/dsh-client-ui-primitives`），
 * 源码不需要经过 lightningcss 预编译即可加载。转换是机械的：
 *
 *   .userRow { display: flex }               → { userRow: { display: "flex" } }
 *   .userRow:hover { ... }                   → { userRow: { "&:hover": { ... } } }
 *   .row .child { ... }                      → { row: { "& .child": { ... } } }
 *   @media (...) { .a { ... } }              → { a: { "@media (...)": { ... } } }
 *   @keyframes spin { from {...} }           → { animations: { spin: { from: {...} } } }
 *   :global(.x) / :root { ... }              → { globals: { ".x": { ... } } }
 *
 * 用法：pnpm exec tsx scripts/migrate-css-modules.mts <packageDir> [--write]
 * 不带 --write 只报告计划（dry run）。
 */

import { glob, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import postcss from "postcss";

type StyleObject = { [key: string]: string | StyleObject };

const [, , packageDir, ...flags] = process.argv;
if (!packageDir) throw new Error("用法：migrate-css-modules.mts <packageDir> [--write]");
const write = flags.includes("--write");

const files = (await Array.fromAsync(glob("src/**/*.module.css", { cwd: packageDir }))).sort();
if (files.length === 0) console.log("没有 .module.css 文件");

/** CSS 属性名 → csstype 键法（`pointer-events` → `pointerEvents`，`-webkit-x` → `WebkitX`）。 */
function toCamelCase(property: string): string {
  if (property.startsWith("--")) return property;
  return property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function declarations(rule: postcss.Rule): StyleObject {
  const result: StyleObject = {};
  for (const node of rule.nodes) {
    if (node.type === "decl") result[toCamelCase(node.prop)] = node.value;
  }
  return result;
}

/**
 * 折成一个类选择器：
 * - `.foo` / `.foo:hover` / `.foo .bar` → (name, `&…`)
 * - `.foo.modifier` → 变体：直接声明归到 `fooModifier`（供 styling.props 合并），
 *   带后代部分时改成 `&[data-modifier] …` 并提示调用方给元素加该属性。
 */
function fold(selector: string): { name: string; nested?: string; variant?: string } | undefined {
  const trimmed = selector.trim();
  if (!trimmed.startsWith(".")) return undefined; // 非类选择器（:root 等）走 globals
  const match = /^\.([A-Za-z0-9_-]+)(?:([\s\S]*))$/.exec(trimmed);
  if (!match) return undefined;
  const name = match[1]!;
  const rest = match[2] ?? "";

  const variantMatch = /^\.([A-Za-z0-9_-]+)([\s\S]*)$/.exec(rest);
  if (variantMatch) {
    const modifier = variantMatch[1]!;
    const tail = variantMatch[2] ?? "";
    const variant = `${name}${modifier[0]!.toUpperCase()}${modifier.slice(1)}`;
    if (tail.trim() === "") return { name, variant };
    return { name, nested: `&[data-${modifier}]${tail}`, variant };
  }
  if (rest === "") return { name };
  // `&` 取代类名本身：`.a:hover` → `&:hover`；`.a .b` → `& .b`。
  return { name, nested: `&${rest}` };
}

function merge(target: StyleObject, key: string, value: StyleObject | string): void {
  const existing = target[key];
  if (existing === undefined) target[key] = value;
  else if (typeof existing === "object" && typeof value === "object")
    Object.assign(existing, value);
  else target[key] = value;
}

function render(node: StyleObject, depth: number): string {
  const pad = "  ".repeat(depth);
  return Object.entries(node)
    .map(([key, value]) =>
      typeof value === "string"
        ? `${pad}  ${JSON.stringify(key)}: ${JSON.stringify(value)},`
        : `${pad}  ${JSON.stringify(key)}: {\n${render(value, depth + 2)}\n${pad}  },`,
    )
    .join("\n");
}

const report: string[] = [];

for (const file of files) {
  const source = await readFile(join(packageDir, file), "utf8");
  const root = postcss.parse(source);
  const styles: StyleObject = {};
  const animations: StyleObject = {};
  const globals: StyleObject = {};

  /** 归并一条规则：`atRule` 是外层 at-rule（如 @media）时，嵌套进对应类。 */
  const addRule = (rule: postcss.Rule, atRule?: string): void => {
    for (const selector of rule.selector.split(",")) {
      const folded = fold(selector);
      if (folded === undefined) {
        report.push(`${file}: 非类选择器 "${rule.selector.trim()}" → globals`);
        merge(globals, rule.selector.trim(), declarations(rule));
        continue;
      }
      const body = declarations(rule);
      const value = atRule === undefined ? body : { [atRule]: body };
      if (folded.variant !== undefined && folded.nested === undefined) {
        merge(styles, folded.variant, value);
        report.push(
          `${file}: 变体 "${folded.variant}"（原 ${rule.selector.trim()}）→ styling.props(base, cond && styles.${folded.variant})`,
        );
        continue;
      }
      const key = folded.nested;
      if (key === undefined) {
        merge(styles, folded.name, value);
        continue;
      }
      if (folded.variant !== undefined) {
        report.push(
          `${file}: "${rule.selector.trim()}" 需要元素带 data-${folded.variant.replace(folded.name, "")} 属性`,
        );
      }
      const holder = (styles[folded.name] ??= {}) as StyleObject;
      merge(holder, key, value);
    }
  };

  for (const node of root.nodes) {
    if (node.type === "comment") continue;
    if (node.type === "rule") addRule(node);
    else if (node.type === "atrule" && node.name === "keyframes") {
      const frames: StyleObject = {};
      for (const child of node.nodes ?? []) {
        if (child.type === "rule") frames[child.selector.trim()] = declarations(child);
      }
      animations[node.params.trim()] = frames;
    } else if (node.type === "atrule" && node.nodes !== undefined) {
      const atRule = `@${node.name} ${node.params}`.trim();
      for (const child of node.nodes) {
        if (child.type === "rule") addRule(child, atRule);
        else if (child.type === "atrule")
          report.push(`${file}: 嵌套 at-rule "@${child.name}" 需要手工处理`);
      }
    } else {
      report.push(`${file}: 顶层 ${node.type} 节点需要人工确认`);
    }
  }

  if (write) {
    const out = join(
      packageDir,
      dirname(file),
      `${file.split("/").pop()!.replace(".module.css", "")}.styles.ts`,
    );
    const importPath = "@morlay/dsh-client-ui-primitives/client";
    const sections: string[] = [
      `// 由 scripts/migrate-css-modules.mts 从 ${file.split("/").pop()} 迁移而来：样式对象取代 CSS Modules。`,
      `import type { CSSProps } from ${JSON.stringify(importPath)};`,
      "",
      `export const styles = {`,
      render(styles, 0),
      `} satisfies Record<string, CSSProps>;`,
    ];
    if (Object.keys(animations).length > 0) {
      sections.push(
        "",
        `export const animations = {`,
        render(animations, 0),
        `} satisfies Record<string, Record<string, CSSProps>>;`,
      );
    }
    if (Object.keys(globals).length > 0) {
      sections.push(
        "",
        `export const globals = {`,
        render(globals, 0),
        `} satisfies Record<string, CSSProps>;`,
      );
    }
    await writeFile(out, `${sections.join("\n")}\n`);
    console.log(`写出 ${relative(process.cwd(), out)}（${Object.keys(styles).length} 个类名）`);
  } else {
    console.log(
      `${file}: ${Object.keys(styles).length} 个类名 / ${Object.keys(animations).length} 组动画 / ${Object.keys(globals).length} 条全局规则`,
    );
  }
}

if (report.length > 0) {
  console.log("\n需要人工确认：");
  for (const line of report) console.log(" -", line);
}
