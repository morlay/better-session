import { relativizeToCwd } from "@deepseek-ai/dsh-util-workspace-path";
import { formatReference } from "@morlay/dsh-client-ui-primitives/client";

export interface ClipboardSource {
  readonly text: string;

  readonly path?: string;

  readonly lineStart?: number;

  readonly lineEnd?: number;

  readonly mediaType?: string;
}

export interface ClipboardDataLike {
  getData(type: string): string;
}

interface ShellClipboard {
  formats(): string[];
  read(type: string): string;
}

function shellClipboard(): ShellClipboard | undefined {
  const shell = (globalThis as { dshDesktop?: { clipboard?: ShellClipboard } }).dshDesktop
    ?.clipboard;
  return shell !== undefined &&
    typeof shell.read === "function" &&
    typeof shell.formats === "function"
    ? shell
    : undefined;
}

export function resolveClipboardData(data: ClipboardDataLike): ClipboardDataLike {
  const shell = shellClipboard();
  if (shell === undefined) return data;
  return {
    getData: (type: string): string => {
      const formats = shell.formats();
      if (!formats.includes(type)) return data.getData(type);

      const value = shell.read(type);
      return value === "" ? data.getData(type) : value;
    },
  };
}

const LANGUAGE_TYPES: Readonly<Record<string, string>> = {
  c: "text/x-c",
  cpp: "text/x-c++",
  csharp: "text/x-csharp",
  css: "text/css",
  go: "text/x-go",
  html: "text/html",
  java: "text/x-java",
  javascript: "text/javascript",
  javascriptreact: "text/jsx",
  json: "application/json",
  jsonc: "application/json",
  markdown: "text/markdown",
  php: "text/x-php",
  python: "text/x-python",
  ruby: "text/x-ruby",
  rust: "text/x-rust",
  scss: "text/x-scss",
  shellscript: "text/x-sh",
  sql: "text/x-sql",
  swift: "text/x-swift",
  toml: "text/x-toml",
  typescript: "text/typescript",
  typescriptreact: "text/tsx",
  xml: "text/xml",
  yaml: "text/x-yaml",
};

const FALLBACK_TYPES: Readonly<Record<string, string>> = {
  bash: "text/x-sh",
  c: "text/x-c",
  cjs: "text/javascript",
  cpp: "text/x-c++",
  css: "text/css",
  cts: "text/typescript",
  go: "text/x-go",
  graphql: "application/graphql",
  h: "text/x-c",
  hpp: "text/x-c++",
  html: "text/html",
  java: "text/x-java",
  js: "text/javascript",
  json: "application/json",
  jsonc: "application/json",
  jsx: "text/jsx",
  kt: "text/x-kotlin",
  lua: "text/x-lua",
  md: "text/markdown",
  mdx: "text/markdown",
  mjs: "text/javascript",
  mts: "text/typescript",
  php: "text/x-php",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  sh: "text/x-sh",
  sql: "text/x-sql",
  svelte: "text/x-svelte",
  swift: "text/x-swift",
  toml: "text/x-toml",
  ts: "text/typescript",
  tsx: "text/tsx",
  vue: "text/x-vue",
  xml: "text/xml",
  yaml: "text/x-yaml",
  yml: "text/x-yaml",
  zsh: "text/x-sh",
};

export function basenameOf(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/u, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? undefined : name;
}

export function mediaTypeOfPath(path: string): string | undefined {
  const name = basenameOf(path);
  const extension = name?.includes(".") === true ? name.split(".").pop() : undefined;
  if (extension === undefined || extension === "") return undefined;
  const key = extension.toLowerCase();
  const mimeTypes = globalThis.navigator?.mimeTypes;
  if (mimeTypes !== undefined) {
    for (const mimeType of Array.from(mimeTypes)) {
      if (mimeType.suffixes.split(",").includes(key)) return mimeType.type;
    }
  }
  return FALLBACK_TYPES[key];
}

function mediaTypeOfHtml(html: string): string | undefined {
  const language =
    /data-language="([^"]+)"/u.exec(html)?.[1] ?? /class="[^"]*language-([\w+-]+)/u.exec(html)?.[1];
  return language === undefined ? undefined : LANGUAGE_TYPES[language];
}

interface ZedEntry {
  readonly len?: unknown;
  readonly file_path?: unknown;
  readonly line_range?: { readonly start?: unknown; readonly end?: unknown };
}

function zedSources(metadata: string, text: string): ClipboardSource[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const sources: ClipboardSource[] = [];
  let cursor = 0;
  for (const raw of parsed) {
    const entry = raw as ZedEntry;
    const length = typeof entry.len === "number" ? entry.len : undefined;

    const segment = length === undefined ? text.slice(cursor) : text.slice(cursor, cursor + length);
    cursor += segment.length;

    while (cursor < text.length && text[cursor] === "\n") cursor += 1;
    const path = typeof entry.file_path === "string" ? entry.file_path : undefined;
    const start = typeof entry.line_range?.start === "number" ? entry.line_range.start : undefined;
    const end = typeof entry.line_range?.end === "number" ? entry.line_range.end : undefined;
    const mediaType = path === undefined ? undefined : mediaTypeOfPath(path);
    sources.push({
      text: segment,
      ...(path === undefined ? {} : { path }),
      ...(start === undefined ? {} : { lineStart: start }),
      ...(end === undefined ? {} : { lineEnd: end }),
      ...(mediaType === undefined ? {} : { mediaType }),
    });
  }
  return sources.length === 0 ? undefined : sources;
}

function vscodeSource(data: string, text: string): ClipboardSource[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  const mode = (parsed as { mode?: unknown }).mode;
  const mediaType = typeof mode === "string" ? LANGUAGE_TYPES[mode] : undefined;
  return [{ text, ...(mediaType === undefined ? {} : { mediaType }) }];
}

export function clipboardSources(data: ClipboardDataLike): ClipboardSource[] {
  const text = data.getData("text/plain");
  const zed = data.getData("zed-metadata");
  if (zed !== "") {
    const sources = zedSources(zed, text);
    if (sources !== undefined) return sources;
  }
  const vscode = data.getData("vscode-editor-data");
  if (vscode !== "") {
    const sources = vscodeSource(vscode, text);
    if (sources !== undefined) return sources;
  }
  const mediaType = mediaTypeOfHtml(data.getData("text/html"));
  return [{ text, ...(mediaType === undefined ? {} : { mediaType }) }];
}

function lineRangeOf(source: ClipboardSource): {
  readonly lineStart?: number;
  readonly lineEnd?: number;
} {
  const { lineStart, lineEnd } = source;
  if (lineStart === undefined) return {};
  if (lineEnd === undefined || lineEnd === lineStart) return { lineStart };
  return { lineStart, lineEnd };
}

export function clipboardUriOf(path: string, cwd: string | undefined): string {
  return relativizeToCwd(path, cwd);
}

export function pasteTextOf(
  sources: readonly ClipboardSource[],
  uriOf: (path: string, index: number) => string,
): string | undefined {
  if (sources.every((source) => source.path === undefined)) return undefined;
  return sources
    .map((source, index) => {
      const path = source.path;
      if (path === undefined) return source.text;
      const uri = uriOf(path, index);
      return formatReference({
        protocol: "file",
        path: uri,
        ...lineRangeOf(source),
      });
    })
    .join("\n\n");
}
