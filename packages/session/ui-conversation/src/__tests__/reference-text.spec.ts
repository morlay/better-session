import { describe, expect, it } from "vitest";
import type { ReferenceInsert } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/draft-editor.ts";
import { insertTextOf, referenceTextOf } from "../client/input/reference-text.ts";

const fileInsert: ReferenceInsert = {
  source: "reference",
  ref: "@src/a.ts",
  label: "a.ts",
  appearance: "file",
  clipboardText: "@src/a.ts",
};

describe("referenceTextOf", () => {
  it("lands a file pick as a scheme URI", () => {
    expect(referenceTextOf(fileInsert)).toEqual({
      source: "reference",
      ref: "@src/a.ts",
      label: "a.ts",
      appearance: "file",
      clipboardText: "file:src/a.ts",
    });
  });

  it("lands a quoted path and a directory pick", () => {
    expect(
      referenceTextOf({ ...fileInsert, ref: '@"my file.ts"', label: "my file.ts" }).clipboardText,
    ).toBe("file:my%20file.ts");
    expect(
      referenceTextOf({ ...fileInsert, ref: "@src/dir/", label: "dir/", appearance: "folder" })
        .clipboardText,
    ).toBe("file:src/dir/");
  });

  it("keeps a session pick as its own mention", () => {
    const session: ReferenceInsert = {
      source: "reference",
      ref: "@[Research](dsh-session:InNvdXJjZSI)",
      label: "Research",
      appearance: "session",
      clipboardText: "@[Research](dsh-session:InNvdXJjZSI)",
    };
    expect(referenceTextOf(session)).toEqual(session);
  });

  it("keeps an insert it cannot read as a file mention", () => {
    expect(referenceTextOf({ ...fileInsert, ref: "no-at-prefix" }).clipboardText).toBe("@src/a.ts");
  });
});

describe("insertTextOf", () => {
  it("lands a skill pick as a scheme token, keeping the closing space", () => {
    expect(insertTextOf("/code-review ")).toBe("skill:code-review ");
    expect(insertTextOf("/code-review")).toBe("skill:code-review");
  });

  it("keeps text that is not a whole skill token", () => {
    expect(insertTextOf("@src/")).toBe("@src/");
    expect(insertTextOf("/code-review 现在")).toBe("/code-review 现在");
    expect(insertTextOf("plain")).toBe("plain");
  });
});
