import { afterEach, describe, expect, it } from "vitest";
import {
  clipboardSources,
  clipboardUriOf,
  pasteTextOf,
  resolveClipboardData,
  mediaTypeOfPath,
  type ClipboardDataLike,
} from "../client/input/clipboard-resource.ts";

const REPO = "/Users/morlay/src/github.com/morlay/better-session";
const JSON_SNIPPET = [
  '  "repository": {',
  '    "type": "git",',
  '    "url": "https://github.com/morlay/better-session.git"',
  "  },",
].join("\n");

function clipboard(entries: Record<string, string>): ClipboardDataLike {
  return { getData: (type: string) => entries[type] ?? "" };
}

describe("clipboardSources", () => {
  it("reads zed-metadata (single selection) into a path + line-range source", () => {
    const sources = clipboardSources(
      clipboard({
        "text/plain": JSON_SNIPPET,
        "zed-text-hash": "abcd1234",
        "zed-metadata": JSON.stringify([
          {
            len: JSON_SNIPPET.length,
            is_entire_line: false,
            first_line_indent: 2,
            file_path: `${REPO}/packages/session/ui-conversation/package.json`,
            line_range: { start: 8, end: 11 },
          },
        ]),
      }),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      text: JSON_SNIPPET,
      path: `${REPO}/packages/session/ui-conversation/package.json`,
      lineStart: 8,
      lineEnd: 11,
      mediaType: "application/json",
    });
  });

  it("splits a multi-selection zed copy into one source per entry", () => {
    const first = "const a = 1";
    const second = "const b = 2";
    const sources = clipboardSources(
      clipboard({
        "text/plain": `${first}\n${second}`,
        "zed-metadata": JSON.stringify([
          { len: first.length, file_path: `${REPO}/a.ts`, line_range: { start: 3, end: 3 } },
          { len: second.length, file_path: `${REPO}/src/b.py`, line_range: { start: 1, end: 1 } },
        ]),
      }),
    );
    expect(sources.map((source) => source.text)).toEqual([first, second]);
    expect(sources.map((source) => source.mediaType)).toEqual(["text/typescript", "text/x-python"]);
  });

  it("reads vscode-editor-data into a language-only source", () => {
    const sources = clipboardSources(
      clipboard({
        "text/plain": JSON_SNIPPET,
        "vscode-editor-data": JSON.stringify({ version: 1, mode: "typescript" }),
      }),
    );
    expect(sources).toEqual([{ text: JSON_SNIPPET, mediaType: "text/typescript" }]);
  });

  it("falls back to the html language marker", () => {
    const sources = clipboardSources(
      clipboard({
        "text/plain": "print('hi')",
        "text/html": '<meta charset="utf-8"><pre data-language="python">print(&#39;hi&#39;)</pre>',
      }),
    );
    expect(sources).toEqual([{ text: "print('hi')", mediaType: "text/x-python" }]);
  });

  it("keeps a meta-less source for editors that only write plain text", () => {
    expect(clipboardSources(clipboard({ "text/plain": "just text" }))).toEqual([
      { text: "just text" },
    ]);
  });

  it("prefers zed metadata over vscode data and ignores malformed json", () => {
    const sources = clipboardSources(
      clipboard({
        "text/plain": "x",
        "vscode-editor-data": JSON.stringify({ version: 1, mode: "python" }),
        "zed-metadata": "{not json",
      }),
    );
    expect(sources).toEqual([{ text: "x", mediaType: "text/x-python" }]);
  });
});

describe("mediaTypeOfPath", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "navigator");
  });

  it("uses the browser mime table first", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mimeTypes: [{ type: "text/x-custom", suffixes: "foo,bar" }] },
    });
    expect(mediaTypeOfPath("a.bar")).toBe("text/x-custom");
    expect(mediaTypeOfPath("a.ts")).toBe("text/typescript");
  });

  it("returns undefined for extension-less paths", () => {
    expect(mediaTypeOfPath("Makefile")).toBeUndefined();
    expect(mediaTypeOfPath("dir/")).toBeUndefined();
  });
});

describe("clipboardUriOf", () => {
  const cwd = "/Users/me/proj";

  it("relativizes an absolute path inside the workspace", () => {
    expect(clipboardUriOf(`${cwd}/src/a.ts`, cwd)).toBe("src/a.ts");
  });

  it("keeps a relative path as it is", () => {
    expect(clipboardUriOf("src/a.ts", cwd)).toBe("src/a.ts");
    expect(clipboardUriOf("../other/a.ts", cwd)).toBe("../other/a.ts");
  });

  it("keeps an absolute path outside the workspace and an unknown root", () => {
    expect(clipboardUriOf("/tmp/a.ts", cwd)).toBe("/tmp/a.ts");
    expect(clipboardUriOf(`${cwd}/src/a.ts`, undefined)).toBe(`${cwd}/src/a.ts`);
  });
});

describe("pasteTextOf", () => {
  it("lands a source with a path and a line range as a ranged file reference", () => {
    expect(
      pasteTextOf(
        [
          {
            text: JSON_SNIPPET,
            path: `${REPO}/packages/session/ui-conversation/package.json`,
            lineStart: 8,
            lineEnd: 11,
          },
        ],
        (path, index) => clipboardUriOf(path, index === 0 ? REPO : undefined),
      ),
    ).toBe("file:packages/session/ui-conversation/package.json#L8-L11");
  });

  it("lands a path-only source without a range", () => {
    expect(pasteTextOf([{ text: "x", path: "/w/a.ts" }], () => "a.ts")).toBe("file:a.ts");
  });

  it("joins several sources with a blank line, collapsing a one-line range", () => {
    expect(
      pasteTextOf(
        [
          { text: "const a = 1", path: "/w/a.ts", lineStart: 3, lineEnd: 3 },
          { text: "const b = 2", path: "/w/b.py", lineStart: 1, lineEnd: 1 },
        ],
        (path) => path.replace("/w/", ""),
      ),
    ).toBe("file:a.ts#L3\n\nfile:b.py#L1");
  });

  it("keeps a path-less segment as its own text", () => {
    expect(
      pasteTextOf([{ text: "const a = 1", path: "/w/a.ts" }, { text: "plain" }], () => "a.ts"),
    ).toBe("file:a.ts\n\nplain");
  });

  it("answers undefined when no source carries a path", () => {
    expect(pasteTextOf([{ text: "just text" }], () => "x")).toBeUndefined();
    expect(
      pasteTextOf([{ text: "print(1)", mediaType: "text/x-python" }], () => "x"),
    ).toBeUndefined();
  });
});

describe("resolveClipboardData", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "dshDesktop");
  });

  it("prefers the desktop shell clipboard for custom formats", () => {
    Object.defineProperty(globalThis, "dshDesktop", {
      configurable: true,
      value: {
        clipboard: {
          formats: () => ["text/plain", "zed-metadata"],
          read: (type: string) =>
            type === "zed-metadata" ? '[{"len":1,"file_path":"/w/a.ts"}]' : "x",
        },
      },
    });
    const sources = clipboardSources(
      resolveClipboardData(clipboard({ "text/plain": "x", "zed-metadata": "" })),
    );
    expect(sources).toEqual([{ text: "x", path: "/w/a.ts", mediaType: "text/typescript" }]);
  });

  it("falls back to the event clipboard when the shell has no such format", () => {
    Object.defineProperty(globalThis, "dshDesktop", {
      configurable: true,
      value: { clipboard: { formats: () => ["text/plain"], read: () => "" } },
    });
    expect(clipboardSources(resolveClipboardData(clipboard({ "text/plain": "plain" })))).toEqual([
      { text: "plain" },
    ]);
  });
});
