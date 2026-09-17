import { describe, expect, it } from "vitest";
import { DIALECT_CAPABILITIES, dialectOf, extendConfinedArgv } from "../dialects.ts";
import { compileRules, ruleSourceOf } from "../rules.ts";

const WORKSPACE = "/ws";

function rules(config: { access?: string[] }) {
  return compileRules(ruleSourceOf(config, {}), WORKSPACE);
}

const SEATBELT_ARGV = [
  "/usr/bin/sandbox-exec",
  "-p",
  '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath "/ws"))',
  "--",
  "bash",
  "-c",
  "echo hi",
];

const BWRAP_ARGV = [
  "bwrap",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  "--bind",
  "/ws",
  "/ws",
  "--",
  "bash",
  "-c",
  "echo hi",
];

const LANDLOCK_ARGV = [
  "/launcher/landlock-run",
  "--ro",
  "/",
  "--rw",
  "/dev/null",
  "--rw",
  "/ws",
  "--",
  "bash",
];

const WINDOWS_ARGV = [
  "node",
  "/runner/index.js",
  "--workspace",
  "/ws",
  "--temp",
  "/tmp/dsh-x",
  "--mode",
  "workspace-write",
  "--",
  "cmd",
];

describe("dialectOf", () => {
  it("按 runner 结构识别四种方言", () => {
    expect(dialectOf(SEATBELT_ARGV)).toBe("seatbelt");
    expect(dialectOf(BWRAP_ARGV)).toBe("bwrap");
    expect(dialectOf(LANDLOCK_ARGV)).toBe("landlock");
    expect(dialectOf(WINDOWS_ARGV)).toBe("windows-acl");
    expect(dialectOf(["/custom/runner", "true"])).toBeUndefined();
  });
});

describe("extendConfinedArgv", () => {
  it("空规则原样返回", () => {
    const extended = extendConfinedArgv(SEATBELT_ARGV, rules({}));
    expect(extended).toEqual(SEATBELT_ARGV);
  });

  it("Seatbelt：allow 与 deny 追加到 profile 末尾（后置规则覆盖先置 allow）", () => {
    const extended = extendConfinedArgv(
      SEATBELT_ARGV,
      rules({ access: ["rw /cache", "-- mise.*.toml", "-- secrets"] }),
    );
    const profile = extended[2] as string;
    expect(extended.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(extended.slice(3)).toEqual(SEATBELT_ARGV.slice(3));
    expect(profile).toContain('(allow file-write* (subpath "/cache"))');
    expect(profile).toContain('(deny file-read* file-write* (subpath "/ws/secrets"))');

    expect(profile).toContain('(deny file-read* file-write* (regex #"^/ws/mise\\.[^/]*\\.toml$"))');
  });

  it("bwrap：allow 用 --bind-try，拒绝项退化为 --ro-bind-try（读仍放行）", () => {
    const extended = extendConfinedArgv(
      BWRAP_ARGV,
      rules({ access: ["rw /cache", "-- mise.toml"] }),
    );
    const separator = extended.indexOf("--");
    const additions = [
      "--bind-try",
      "/cache",
      "/cache",
      "--ro-bind-try",
      "/ws/mise.toml",
      "/ws/mise.toml",
    ];
    expect(extended).toEqual([
      ...BWRAP_ARGV.slice(0, BWRAP_ARGV.indexOf("--")),
      ...additions,
      ...BWRAP_ARGV.slice(BWRAP_ARGV.indexOf("--")),
    ]);
    expect(separator).toBe(BWRAP_ARGV.indexOf("--") + additions.length);
  });

  it("Landlock：只追加可写授权（其 allow-list 无法表达子路径拒绝）", () => {
    const extended = extendConfinedArgv(
      LANDLOCK_ARGV,
      rules({ access: ["rw /cache", "-- mise.toml"] }),
    );
    expect(extended).toEqual([
      "/launcher/landlock-run",
      "--ro",
      "/",
      "--rw",
      "/dev/null",
      "--rw",
      "/ws",
      "--rw",
      "/cache",
      "--",
      "bash",
    ]);
  });

  it("windows-acl：无表达，保留原 argv", () => {
    const extended = extendConfinedArgv(
      WINDOWS_ARGV,
      rules({ access: ["rw /cache", "-- mise.toml"] }),
    );
    expect(extended).toEqual(WINDOWS_ARGV);
  });

  it("Seatbelt：r- 只 deny 写入，-- 才 deny 读", () => {
    const profile = extendConfinedArgv(
      SEATBELT_ARGV,
      rules({ access: ["r- /config", "-- mise.toml"] }),
    )[2] as string;
    expect(profile).toContain('(deny file-write* (subpath "/config"))');
    expect(profile).toContain('(deny file-read* file-write* (subpath "/ws/mise.toml"))');
  });

  it("bwrap：r- 与 -- 都表达为只读挂载（-- 退化为只拒写）", () => {
    const extended = extendConfinedArgv(
      BWRAP_ARGV,
      rules({ access: ["r- /config", "-- mise.toml"] }),
    ).join(" ");
    expect(extended).toContain("--ro-bind-try /config /config");
    expect(extended).toContain("--ro-bind-try /ws/mise.toml /ws/mise.toml");
  });

  it("Landlock：r- 无表达，只追加 rw", () => {
    const extended = extendConfinedArgv(
      LANDLOCK_ARGV,
      rules({ access: ["r- /config", "rw /cache"] }),
    );
    expect(extended).toEqual([
      "/launcher/landlock-run",
      "--ro",
      "/",
      "--rw",
      "/dev/null",
      "--rw",
      "/ws",
      "--rw",
      "/cache",
      "--",
      "bash",
    ]);
  });

  it("无法识别的 runner 在有规则时抛错（规则不能静默失效）", () => {
    expect(() =>
      extendConfinedArgv(["/custom/runner", "--", "true"], rules({ access: ["-- x"] })),
    ).toThrow(/unrecognized sandbox runner argv/);
    expect(() =>
      extendConfinedArgv(["bwrap", "--ro-bind", "/", "/"], rules({ access: ["rw /cache"] })),
    ).toThrow(/no `--` separator/);
  });

  it("表达能力表与实现一致", () => {
    expect(DIALECT_CAPABILITIES.seatbelt.readOnly).toBe(true);
    expect(DIALECT_CAPABILITIES.seatbelt.denyReadWrite).toBe(true);
    expect(DIALECT_CAPABILITIES.bwrap).toEqual({
      allowWrite: true,
      readOnly: true,
      denyReadWrite: false,
      denyWriteOnly: true,
    });
    expect(DIALECT_CAPABILITIES.landlock.allowWrite).toBe(true);
    expect(DIALECT_CAPABILITIES.landlock.readOnly).toBe(false);
    expect(DIALECT_CAPABILITIES["windows-acl"].allowWrite).toBe(false);
    expect(DIALECT_CAPABILITIES["windows-acl"].readOnly).toBe(false);
  });
});
