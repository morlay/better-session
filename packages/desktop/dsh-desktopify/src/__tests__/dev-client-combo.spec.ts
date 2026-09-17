import { describe, expect, it } from "vitest";
import { comboEntryIds, stripSourceMapTrailer } from "../dev-client/combo.ts";

describe("comboEntryIds", () => {
  it("reads the package list out of a combo URL", () => {
    expect(
      comboEntryIds(
        "/plugins/??@morlay/dsh-client-ui-chat/client.js,@deepseek-ai/dsh-client-ui-slots/client.js&rev=abc123",
      ),
    ).toEqual(["@morlay/dsh-client-ui-chat", "@deepseek-ai/dsh-client-ui-slots"]);
  });

  it("accepts the single-resource form", () => {
    expect(comboEntryIds("/plugins/??react/client.js&rev=abc123")).toEqual(["react"]);
  });

  it("rejects source-map resources, non-combo paths, and empty lists", () => {
    expect(comboEntryIds("/plugins/??a/client.js.map&rev=abc")).toBeUndefined();
    expect(comboEntryIds("/plugins/a/client.js")).toBeUndefined();
    expect(comboEntryIds("/plugins/??&rev=abc")).toBeUndefined();
    expect(comboEntryIds("/plugins/events")).toBeUndefined();
  });
});

describe("stripSourceMapTrailer", () => {
  it("drops the trailer and keeps the body", () => {
    expect(
      stripSourceMapTrailer("var a = 1;\n//# sourceMappingURL=/plugins/??x/client.js.map\n"),
    ).toBe("var a = 1;\n");
  });

  it("leaves a trailer-free bundle untouched", () => {
    expect(stripSourceMapTrailer("var a = 1;\n")).toBe("var a = 1;\n");
  });
});
