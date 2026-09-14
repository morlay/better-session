import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import {
  blocksWrite,
  compileRules,
  expandEnvTemplates,
  globToRegexSource,
  isEmptyRules,
  isDenied,
  isReadOnly,
  parseAccess,
  ruleSourceOf,
  withoutAllowRoots,
  writableRootsWith,
} from "../rules.ts";

const WORKSPACE = "/ws";

/** 把 `-- <pattern>` 条目编译成规则。 */
function denyRules(entries: string[], workspace = WORKSPACE) {
  return compileRules(
    ruleSourceOf({ access: entries.map((entry) => `-- ${entry}`) }, {}),
    workspace,
  );
}

/** 把 `r- <path>` 条目编译成规则。 */
function readOnlyRules(entries: string[], workspace = WORKSPACE) {
  return compileRules(
    ruleSourceOf({ access: entries.map((entry) => `r- ${entry}`) }, {}),
    workspace,
  );
}

describe("parseAccess", () => {
  it("解析数组形式（每项一条），前缀决定归属", () => {
    const parsed = parseAccess([
      "rw /cache",
      "r- /config",
      "-- mise.*.toml",
      "rw build",
      "r- {{ env.XDG_STATE_HOME }}",
      "-- **/*.pem",
    ]);
    expect(parsed.allowWrite).toEqual(["/cache", "build"]);
    expect(parsed.readOnly).toEqual(["/config", "{{ env.XDG_STATE_HOME }}"]);
    expect(parsed.deny).toEqual(["mise.*.toml", "**/*.pem"]);
  });

  it("解析多行文本形式（每行一条），空行与缩进忽略", () => {
    const parsed = parseAccess(
      ["  rw {{ env.XDG_CACHE_HOME }}", "", "  -- mise.*.toml", "-- **/*.pem", ""].join("\n"),
    );
    expect(parsed.allowWrite).toEqual(["{{ env.XDG_CACHE_HOME }}"]);
    expect(parsed.deny).toEqual(["mise.*.toml", "**/*.pem"]);
  });

  it("空配置与未配置等价", () => {
    expect(parseAccess(undefined)).toEqual({ allowWrite: [], readOnly: [], deny: [] });
    expect(parseAccess([])).toEqual({ allowWrite: [], readOnly: [], deny: [] });
    expect(parseAccess("\n\n")).toEqual({ allowWrite: [], readOnly: [], deny: [] });
  });

  it("缺前缀或前缀后没有路径时报错（规则不因写法歧义而变形）", () => {
    expect(() => parseAccess(["mise.*.toml"])).toThrow(/must start with "rw " .*or "-- "/);
    expect(() => parseAccess("rwfoo /cache")).toThrow(/must start with/);
    expect(() => parseAccess(["rw", "--"])).toThrow(/carries no path/);
  });
});

describe("expandEnvTemplates", () => {
  it("展开 {{ env.NAME }} 并保留其余文本", () => {
    expect(expandEnvTemplates("{{ env.XDG_CACHE_HOME }}/foo", { XDG_CACHE_HOME: "/cache" })).toBe(
      "/cache/foo",
    );
    expect(expandEnvTemplates("{{env.HOME}}", { HOME: "/home/u" })).toBe("/home/u");
    expect(expandEnvTemplates("/plain/path", {})).toBe("/plain/path");
  });

  it("引用未设置或为空的环境变量时抛错（规则不静默变形）", () => {
    expect(() => expandEnvTemplates("{{ env.MISSING }}", {})).toThrow(
      /unset environment variable "MISSING"/,
    );
    expect(() => expandEnvTemplates("{{ env.EMPTY }}", { EMPTY: "" })).toThrow(/unset/);
  });
});

describe("globToRegexSource", () => {
  it("* 不跨目录、** 跨目录、**/ 匹配零层", () => {
    const single = globToRegexSource("/ws/mise.*.toml");
    expect(new RegExp(`^${single}$`).test("/ws/mise.local.toml")).toBe(true);
    expect(new RegExp(`^${single}$`).test("/ws/sub/mise.local.toml")).toBe(false);

    const nested = globToRegexSource("/ws/**/*.pem");
    expect(new RegExp(`^${nested}$`).test("/ws/key.pem")).toBe(true);
    expect(new RegExp(`^${nested}$`).test("/ws/a/b/key.pem")).toBe(true);

    const deep = globToRegexSource("/ws/**");
    expect(new RegExp(`^${deep}$`).test("/ws/a/b")).toBe(true);
  });

  it("转义正则元字符、透传字符类（[!…] 按 glob 习惯取反）", () => {
    expect(new RegExp(`^${globToRegexSource("/ws/a.b")}$`).test("/ws/aXb")).toBe(false);
    expect(new RegExp(`^${globToRegexSource("/ws/a?c")}$`).test("/ws/abc")).toBe(true);
    expect(new RegExp(`^${globToRegexSource("/ws/[ab].txt")}$`).test("/ws/b.txt")).toBe(true);
    expect(new RegExp(`^${globToRegexSource("/ws/[!ab].txt")}$`).test("/ws/c.txt")).toBe(true);
    expect(new RegExp(`^${globToRegexSource("/ws/[!ab].txt")}$`).test("/ws/a.txt")).toBe(false);
    // 只用 JS 与 POSIX ERE 共有的语法（Seatbelt 要用同一份源码）。
    expect(globToRegexSource("/ws/**/*.pem")).not.toContain("(?:");
  });
});

describe("compileRules", () => {
  it("相对规则相对工作区绝对化，字面规则命中自身与后代", () => {
    const rules = denyRules(["mise.toml", "secrets"]);
    expect(rules.denySubtrees).toEqual([join(WORKSPACE, "mise.toml"), join(WORKSPACE, "secrets")]);
    expect(isDenied(rules, join(WORKSPACE, "mise.toml"))).toBe(true);
    expect(isDenied(rules, join(WORKSPACE, "secrets/deep/token"))).toBe(true);
    expect(isDenied(rules, join(WORKSPACE, "secretsx"))).toBe(false);
    expect(isDenied(rules, join(WORKSPACE, "readme.md"))).toBe(false);
  });

  it("glob 规则按模式匹配，绝对规则原样保留", () => {
    const rules = denyRules(["mise.*.toml", "/etc/ssl/**/*.pem"]);
    expect(rules.denySubtrees).toEqual([]);
    expect(isDenied(rules, join(WORKSPACE, "mise.local.toml"))).toBe(true);
    expect(isDenied(rules, join(WORKSPACE, "sub/mise.local.toml"))).toBe(false);
    expect(isDenied(rules, "/etc/ssl/private/key.pem")).toBe(true);
    expect(isDenied(rules, "/etc/ssl/readme.md")).toBe(false);
  });

  it("rw 条目支持模板与相对路径，但必须是具体路径", () => {
    const source = ruleSourceOf(
      { access: ["rw {{ env.CACHE }}", "rw build"] },
      { CACHE: "/cache" },
    );
    const rules = compileRules(source, WORKSPACE);
    expect(rules.allowRoots).toEqual(["/cache", join(WORKSPACE, "build")]);
    expect(() => compileRules(ruleSourceOf({ access: ["rw build/*"] }, {}), WORKSPACE)).toThrow(
      /must name a concrete path/,
    );
  });

  it("空规则与 withoutAllowRoots", () => {
    const empty = compileRules(ruleSourceOf({}, {}), WORKSPACE);
    expect(isEmptyRules(empty)).toBe(true);
    const rules = compileRules(ruleSourceOf({ access: ["rw /cache", "-- x"] }, {}), WORKSPACE);
    expect(isEmptyRules(rules)).toBe(false);
    expect(withoutAllowRoots(rules).allowRoots).toEqual([]);
    expect(isEmptyRules(withoutAllowRoots(rules))).toBe(false);
  });

  it("r- 条目允许读、拒绝写，且优先于可写根", () => {
    const rules = readOnlyRules(["config", "**/*.pem"]);
    const file = join(WORKSPACE, "config", "app.toml");
    expect(isReadOnly(rules, file)).toBe(true);
    expect(blocksWrite(rules, file)).toBe(true);
    expect(isDenied(rules, file)).toBe(false);
    expect(isReadOnly(rules, join(WORKSPACE, "a/key.pem"))).toBe(true);
    expect(isReadOnly(rules, join(WORKSPACE, "readme.md"))).toBe(false);
  });

  it("命中优先级：-- 拒绝覆盖 r-，r- 覆盖可写根", () => {
    const rules = compileRules(
      ruleSourceOf({ access: ["rw .", "r- guarded", "-- guarded/secret"] }, {}),
      WORKSPACE,
    );
    expect(blocksWrite(rules, join(WORKSPACE, "guarded", "note.md"))).toBe(true);
    expect(isDenied(rules, join(WORKSPACE, "guarded", "note.md"))).toBe(false);
    expect(isDenied(rules, join(WORKSPACE, "guarded", "secret"))).toBe(true);
    expect(isReadOnly(rules, join(WORKSPACE, "plain.md"))).toBe(false);
  });

  it("writableRootsWith 把 rw 条目计入可写根，read-only 不追加", () => {
    const rules = compileRules(ruleSourceOf({ access: ["rw /cache"] }, {}), WORKSPACE);
    const writable: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
    expect(writableRootsWith(rules, writable)).toContain("/cache");
    const readOnly: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: WORKSPACE };
    expect(writableRootsWith(rules, readOnly)).toEqual([]);
  });
});
