import { describe, expect, it } from "vitest";
import { queueTextOf } from "../client/queue/queue-text.ts";

describe("queueTextOf", () => {
  it("prefers the untruncated text projection", () => {
    const link = "@[a.ts](file:src/a.ts)";
    expect(queueTextOf({ text: link, preview: `${link.slice(0, 10)}…` })).toBe(link);
  });

  it("falls back to the preview when text is absent (mixed attachments)", () => {
    expect(queueTextOf({ text: null, preview: "看这个 [file]" })).toBe("看这个 [file]");
  });
});
