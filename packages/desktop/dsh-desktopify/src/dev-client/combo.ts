export const COMBO_PATH = "/plugins/";

const CLIENT_RESOURCE = /^(?<id>.+)\/client\.js$/u;

const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u;

export function comboEntryIds(requestUrl: string): string[] | undefined {
  const query = requestUrl.slice(requestUrl.indexOf("?") + 1);
  if (!query.startsWith("?")) return undefined;
  const list = query.slice(1).split("&", 1)[0] ?? "";
  if (list === "") return undefined;
  const ids: string[] = [];
  for (const resource of list.split(",")) {
    const matched = CLIENT_RESOURCE.exec(resource);
    const id = matched?.groups?.id;
    if (id === undefined || id === "") return undefined;
    ids.push(id);
  }
  return ids;
}

export function stripSourceMapTrailer(code: string): string {
  return code.replace(SOURCE_MAP_TRAILER, "\n");
}
