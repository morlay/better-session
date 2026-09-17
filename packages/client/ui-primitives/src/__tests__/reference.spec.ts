import { describe, expect, it } from "vitest";
import {
  findReferences,
  formatReference,
  isLocalReference,
  parseReference,
  parseReferenceToken,
} from "../reference.ts";
import type { Reference } from "../reference.ts";

function referencesOf(text: string): readonly (Reference & { readonly slice: string })[] {
  return findReferences(text).map((span) => ({
    slice: text.slice(span.start, span.end),
    ...span.reference,
  }));
}

function onlyReference(text: string): Reference | undefined {
  return findReferences(text)[0]?.reference;
}

describe("findReferences 的书写形态", () => {
  it("recognizes a bare skill URI with and without the @ prefix", () => {
    expect(referencesOf("@skill:xxx-skill")).toEqual([
      { slice: "@skill:xxx-skill", protocol: "skill", path: "xxx-skill" },
    ]);
    expect(referencesOf("skill:xxx-skill")).toEqual([
      { slice: "skill:xxx-skill", protocol: "skill", path: "xxx-skill" },
    ]);
  });

  it("reads @path:line:column as a file reference", () => {
    expect(referencesOf("@xxx:1:2")).toEqual([
      { slice: "@xxx:1:2", protocol: "file", path: "xxx", lineStart: 1, column: 2 },
    ]);

    expect(onlyReference("@/abs/path.ts:12")).toEqual({
      protocol: "file",
      path: "/abs/path.ts",
      lineStart: 12,
    });
  });

  it("reads a markdown link with the default file protocol and the label as title", () => {
    expect(referencesOf("[label](src/a.ts)")).toEqual([
      { slice: "[label](src/a.ts)", protocol: "file", path: "src/a.ts", title: "label" },
    ]);
  });

  it("reads the line range in a link fragment", () => {
    expect(referencesOf("[label](src/a.ts#L12-L40)")).toEqual([
      {
        slice: "[label](src/a.ts#L12-L40)",
        protocol: "file",
        path: "src/a.ts",
        title: "label",
        lineStart: 12,
        lineEnd: 40,
      },
    ]);
  });

  it("keeps the official mention form's scheme and puts the label in the title", () => {
    const spans = findReferences("@[label](dsh-session:abc)");
    expect(spans).toHaveLength(1);

    expect(spans[0]?.start).toBe(0);
    expect(spans[0]?.end).toBe("@[label](dsh-session:abc)".length);
    expect(spans[0]?.reference).toEqual({
      protocol: "dsh-session",
      path: "abc",
      title: "label",
    });

    expect(formatReference(spans[0]?.reference as Reference)).toBe("dsh-session:abc");
  });
});

describe("@path 的裸路径形态", () => {
  it("reads a bare @path — extension, directory, absolute and quoted-ish forms — as a file reference", () => {
    expect(referencesOf("@mise.toml")).toEqual([
      { slice: "@mise.toml", protocol: "file", path: "mise.toml" },
    ]);
    expect(onlyReference("@src/a.ts")).toEqual({ protocol: "file", path: "src/a.ts" });
    expect(onlyReference("@/abs/path.ts")).toEqual({ protocol: "file", path: "/abs/path.ts" });
    expect(onlyReference("@../up/file.ts")).toEqual({ protocol: "file", path: "../up/file.ts" });
    expect(onlyReference("@.env")).toEqual({ protocol: "file", path: ".env" });
  });

  it("reads the line fragment that follows the path", () => {
    expect(onlyReference("@mise.toml#L12")).toEqual({
      protocol: "file",
      path: "mise.toml",
      lineStart: 12,
    });
    expect(onlyReference("@src/a.ts#L12-L40")).toEqual({
      protocol: "file",
      path: "src/a.ts",
      lineStart: 12,
      lineEnd: 40,
    });
    expect(onlyReference("@src/a.ts#L12C3-L40")).toEqual({
      protocol: "file",
      path: "src/a.ts",
      lineStart: 12,
      lineEnd: 40,
      column: 3,
    });
  });

  it("treats every @handle as a path (this UI has no people to cue)", () => {
    expect(referencesOf("@alice 你好")).toEqual([
      { slice: "@alice", protocol: "file", path: "alice" },
    ]);
    expect(onlyReference("@中文名")).toEqual({ protocol: "file", path: "中文名" });
  });

  it("stops at prose punctuation and whitespace", () => {
    expect(referencesOf("看 @mise.toml 的配置")).toEqual([
      { slice: "@mise.toml", protocol: "file", path: "mise.toml" },
    ]);
    expect(referencesOf("(@mise.toml)")).toEqual([
      { slice: "@mise.toml", protocol: "file", path: "mise.toml" },
    ]);
    expect(referencesOf("@README.md#L1-L3。看")).toEqual([
      { slice: "@README.md#L1-L3", protocol: "file", path: "README.md", lineStart: 1, lineEnd: 3 },
    ]);
  });

  it("rejects a lone at sign and a non-path neighbour", () => {
    expect(referencesOf("@")).toEqual([]);
    expect(referencesOf("@ 你好")).toEqual([]);
    expect(referencesOf("x@y")).toEqual([]);
  });
});

describe("裸 URI 的边界", () => {
  it("stops at prose punctuation and whitespace", () => {
    expect(referencesOf("看 file:mise.toml。这段")).toEqual([
      { slice: "file:mise.toml", protocol: "file", path: "mise.toml" },
    ]);
    expect(referencesOf("(file:src/a.ts)")).toEqual([
      { slice: "file:src/a.ts", protocol: "file", path: "src/a.ts" },
    ]);
    expect(referencesOf("file:src/a.ts, 以及 file:b.ts")).toEqual([
      { slice: "file:src/a.ts", protocol: "file", path: "src/a.ts" },
      { slice: "file:b.ts", protocol: "file", path: "b.ts" },
    ]);
  });

  it("requires a word boundary before the construct", () => {
    expect(referencesOf("xfile:y")).toEqual([]);
    expect(referencesOf("skill: 不是引用")).toEqual([]);
    expect(referencesOf("file:")).toEqual([]);
  });

  it("is case insensitive on the scheme and keeps the path as written", () => {
    expect(onlyReference("FILE:src/A.ts")).toEqual({ protocol: "file", path: "src/A.ts" });
    expect(onlyReference("Skill:CodeReview")).toEqual({ protocol: "skill", path: "CodeReview" });
  });

  it("reads line ranges, single lines and columns from the fragment", () => {
    expect(onlyReference("file:src/a.ts#L12-L40")).toEqual({
      protocol: "file",
      path: "src/a.ts",
      lineStart: 12,
      lineEnd: 40,
    });
    expect(onlyReference("file:src/a.ts#L12")).toEqual({
      protocol: "file",
      path: "src/a.ts",
      lineStart: 12,
    });
    expect(onlyReference("file:src/a.ts#L12C3-L40")).toEqual({
      protocol: "file",
      path: "src/a.ts",
      lineStart: 12,
      lineEnd: 40,
      column: 3,
    });
  });
});

describe("http(s) 与外部地址", () => {
  it("parses a link into origin and path", () => {
    expect(referencesOf("[docs](https://example.com/a/b?x=1)")).toEqual([
      {
        slice: "[docs](https://example.com/a/b?x=1)",
        protocol: "https",
        origin: "https://example.com",
        path: "a/b?x=1",
        title: "docs",
      },
    ]);
  });

  it("recognizes a bare autolink URL and a bare email (GFM autolink literal)", () => {
    expect(onlyReference("https://example.com/a/b")).toEqual({
      protocol: "https",
      origin: "https://example.com",
      path: "a/b",
      title: "https://example.com/a/b",
    });
    expect(onlyReference("a@b.com")?.protocol).toBe("mailto");
  });

  it("keeps external addresses out of the link → chip conversion", () => {
    expect(isLocalReference({ protocol: "https", origin: "https://example.com" })).toBe(false);
    expect(isLocalReference({ protocol: "mailto", path: "a@b.com" })).toBe(false);
    expect(isLocalReference({ protocol: "file", path: "src/a.ts" })).toBe(true);
    expect(isLocalReference({ protocol: "skill", path: "code-review" })).toBe(true);
    expect(isLocalReference({ protocol: "dsh-session", path: "abc" })).toBe(true);
  });
});

describe("代码块与 inline code", () => {
  it("ignores references inside fenced and indented code blocks", () => {
    expect(referencesOf("```\nfile:mise.toml\n```")).toEqual([]);
    expect(referencesOf("```md\n[a](b.md)\n```")).toEqual([]);
    expect(referencesOf("    file:mise.toml")).toEqual([]);
  });

  it("ignores references inside inline code", () => {
    expect(referencesOf("`skill:x`")).toEqual([]);
    expect(referencesOf("`[a](b.md)`")).toEqual([]);
    expect(referencesOf("[`file:x`](file:y)")).toEqual([
      { slice: "[`file:x`](file:y)", protocol: "file", path: "y", title: "file:x" },
    ]);
  });

  it("ignores a reference written inside a link label", () => {
    expect(referencesOf("[file:x](y)")).toEqual([
      { slice: "[file:x](y)", protocol: "file", path: "y", title: "file:x" },
    ]);
  });
});

describe("多个引用", () => {
  it("returns spans in document order with offsets into the original text", () => {
    const text = "先 file:mise.toml，再 @skill:code-review，最后 [文档](docs/a.md#L3)";
    const spans = findReferences(text);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "file:mise.toml",
      "@skill:code-review",
      "[文档](docs/a.md#L3)",
    ]);
    expect(spans.map((span) => span.reference)).toEqual([
      { protocol: "file", path: "mise.toml" },
      { protocol: "skill", path: "code-review" },
      { protocol: "file", path: "docs/a.md", title: "文档", lineStart: 3 },
    ]);
    for (const span of spans) {
      expect(text.slice(span.start, span.end).length).toBe(span.end - span.start);
    }
  });

  it("returns nothing for plain prose", () => {
    expect(findReferences("")).toEqual([]);
    expect(findReferences("普通的一段话，没有任何引用")).toEqual([]);
  });
});

describe("parseReference / formatReference", () => {
  it("defaults to the file protocol without a scheme", () => {
    expect(parseReference("src/a.ts")).toEqual({ protocol: "file", path: "src/a.ts" });
    expect(parseReference("src/a.ts#L12-L40")).toEqual({
      protocol: "file",
      path: "src/a.ts",
      lineStart: 12,
      lineEnd: 40,
    });
  });

  it("round-trips the token forms", () => {
    const tokens = [
      "file:src/a.ts",
      "file:src/a.ts#L12",
      "file:src/a.ts#L12-L40",
      "file:src/a.ts#L12C3-L40",
      "file:src/session/",
      "file:src/my%20file.ts#L3",
      "skill:code-review",
      "dsh-session:abc",
    ];
    for (const token of tokens) {
      expect(formatReference(parseReference(token) as Reference)).toBe(token);
    }
  });

  it("encodes what would break the token syntax", () => {
    expect(formatReference({ protocol: "file", path: "src/my file(1).ts" })).toBe(
      "file:src/my%20file%281%29.ts",
    );
    expect(parseReference("file:src/my%20file%281%29.ts")).toEqual({
      protocol: "file",
      path: "src/my file(1).ts",
    });
  });

  it("rejects values that carry no reference", () => {
    expect(parseReference("")).toBeUndefined();
    expect(parseReference("file:")).toBeUndefined();
    expect(parseReference("skill:")).toBeUndefined();
    expect(parseReference("skill:not a name")).toBeUndefined();
    expect(parseReference("file:%E0%A4%A")).toBeUndefined();
  });
});

describe("parseReferenceToken", () => {
  it("only accepts explicit scheme tokens (inline code 的判定)", () => {
    expect(parseReferenceToken("file:mise.toml")).toEqual({ protocol: "file", path: "mise.toml" });
    expect(parseReferenceToken("skill:code-review")).toEqual({
      protocol: "skill",
      path: "code-review",
    });
    expect(parseReferenceToken("Makefile")).toBeUndefined();
    expect(parseReferenceToken("pnpm install")).toBeUndefined();
    expect(parseReferenceToken("@mise.toml")).toBeUndefined();
    expect(parseReferenceToken("src/a.ts#L12-L40")).toBeUndefined();
    expect(parseReferenceToken("https://example.com/a")).toEqual({
      protocol: "https",
      origin: "https://example.com",
      path: "a",
    });
  });
});
