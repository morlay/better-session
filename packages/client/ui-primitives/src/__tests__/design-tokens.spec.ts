import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { designTokens } from "../client/theme.generated.ts";
import { Token } from "../client/styling/token.ts";

const THEME_ROOT = join(process.cwd(), "vendor/deepseek-harness/packages/client/ui-theme/src");

async function upstreamTokens(): Promise<string[]> {
  const files = [
    ...(await Array.fromAsync(glob("styles/**/*.css", { cwd: THEME_ROOT }))),
    ...(await Array.fromAsync(glob("**/*.ts", { cwd: THEME_ROOT }))),
  ];
  const names = new Set<string>();
  for (const file of files) {
    const text = await readFile(join(THEME_ROOT, file), "utf8");
    for (const match of text.matchAll(/--dsw-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g))
      names.add(match[1] ?? "");
  }
  return [...names].sort();
}

function treePaths(): string[] {
  const paths: string[] = [];
  const walk = (node: Record<string, unknown>, parents: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$") paths.push(parents.join("-"));
      else if (typeof value === "object" && value !== null)
        walk(value as Record<string, unknown>, [...parents, key]);
      else paths.push([...parents, key].join("-"));
    }
  };
  walk(designTokens as unknown as Record<string, unknown>, []);
  return [...new Set(paths)].sort();
}

describe("design tokens", () => {
  it("树覆盖上游全部 `--dsw-*`，无多无少（漂移即失败：重跑 gen:tokens）", async () => {
    expect(treePaths()).toEqual(await upstreamTokens());
  });

  it("每个叶子都带默认值（类型推导与 fallback 都依赖它）", () => {
    const values: unknown[] = [];
    const walk = (node: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === "object" && value !== null) walk(value as Record<string, unknown>);
        else if (key !== "$") values.push(value);
      }
    };
    walk(designTokens as unknown as Record<string, unknown>);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(typeof value === "string" && value.length > 0).toBe(true);
  });

  it("每个叶子都能生成对应的变量名（往返无损）", () => {
    const token = new Token("dsw");
    for (const path of treePaths()) {
      expect(token.cssVar(path.split("-")), path).toBe(`--dsw-${path}`);
    }
  });
});
