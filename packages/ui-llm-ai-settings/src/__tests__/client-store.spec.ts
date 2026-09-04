import { describe, expect, it } from "vitest";
import {
  deleteProviderOp,
  deriveKeyRef,
  draftFrom,
  opsFor,
  profilePathOps,
  providerIdsOf,
  stringOf,
} from "../client/store.ts";

describe("providerIdsOf", () => {
  it("reads provider route keys in configuration order", () => {
    expect(providerIdsOf({ providers: { b: {}, a: {} } })).toEqual(["b", "a"]);
  });

  it("returns [] for undefined, null, arrays, or a missing dict", () => {
    expect(providerIdsOf(undefined)).toEqual([]);
    expect(providerIdsOf({})).toEqual([]);
    expect(providerIdsOf({ providers: null })).toEqual([]);
    expect(providerIdsOf({ providers: [] })).toEqual([]);
    expect(providerIdsOf({ providers: "nope" })).toEqual([]);
  });
});

describe("deriveKeyRef", () => {
  it("uppercases and slugs a route into the conventional env name", () => {
    expect(deriveKeyRef("ollama")).toBe("OLLAMA_API_KEY");
    expect(deriveKeyRef("openai-official")).toBe("OPENAI_OFFICIAL_API_KEY");
    expect(deriveKeyRef("minimax-cn")).toBe("MINIMAX_CN_API_KEY");
  });
});

describe("profilePathOps", () => {
  it("emits set ops only for fields that changed", () => {
    const ops = profilePathOps(
      ["providers", "ollama"],
      { api: "openai-compatible", baseURL: "https://a/v1", topP: 0.9 },
      { api: "openai-compatible", baseURL: "https://b/v1", topP: 0.9 },
    );
    expect(ops).toEqual([{ op: "set", path: ["providers", "ollama", "baseURL"], value: "https://b/v1" }]);
  });

  it("emits unset for a field that disappeared", () => {
    const ops = profilePathOps(["providers", "p"], { topP: 0.9 }, {});
    expect(ops).toEqual([{ op: "unset", path: ["providers", "p", "topP"] }]);
  });

  it("returns no ops for an identical profile", () => {
    const ops = profilePathOps(["providers", "p"], { a: 1 }, { a: 1 });
    expect(ops).toEqual([]);
  });

  it("treats an absent before as empty (all fields set)", () => {
    const ops = profilePathOps(["providers", "p"], undefined, { a: 1 });
    expect(ops).toEqual([{ op: "set", path: ["providers", "p", "a"], value: 1 }]);
  });
});

describe("deleteProviderOp", () => {
  it("unsets the whole provider subtree", () => {
    expect(deleteProviderOp("ollama")).toEqual({ op: "unset", path: ["providers", "ollama"] });
  });
});

describe("draftFrom", () => {
  it("projects a resolved profile into editable fields", () => {
    expect(draftFrom({ api: "openai", baseURL: "https://x/v1", displayName: "X", models: [{ id: "a" }] }))
      .toEqual({
        apiKeyEnv: "",
        api: "openai",
        baseURL: "https://x/v1",
        displayName: "X",
        models: '[\n  {\n    "id": "a"\n  }\n]',
      });
  });

  it("defaults api to openai-compatible and models to [] JSON", () => {
    expect(draftFrom(undefined)).toEqual({
      apiKeyEnv: "", api: "openai-compatible", baseURL: "", displayName: "", models: "[]",
    });
  });

  it("keeps a pre-serialized models string verbatim", () => {
    expect(draftFrom({ models: "[1]" }).models).toBe("[1]");
  });
});

describe("opsFor", () => {
  it("emits set for changed fields, skipping untouched ones", () => {
    const { ops, error } = opsFor("p", {
      api: "openai-compatible", baseURL: "https://a/v1", topP: 0.9, models: [],
    }, {
      apiKeyEnv: "", api: "openai-compatible", baseURL: "https://b/v1", displayName: "P", models: "[]",
    });
    expect(error).toBeUndefined();
    expect(ops).toEqual([
      { op: "set", path: ["providers", "p", "baseURL"], value: "https://b/v1" },
      { op: "set", path: ["providers", "p", "displayName"], value: "P" },
    ]);
  });

  it("clears a field when its draft is emptied", () => {
    const { ops } = opsFor("p", { apiKeyEnv: "K_API_KEY" }, {
      apiKeyEnv: "", api: "openai-compatible", baseURL: "", displayName: "", models: "[]",
    });
    expect(ops).toContainEqual({ op: "unset", path: ["providers", "p", "apiKeyEnv"] });
  });

  it("reports malformed models JSON as an error without ops", () => {
    const { ops, error } = opsFor("p", undefined, {
      apiKeyEnv: "", api: "openai-compatible", baseURL: "", displayName: "", models: "{ nope",
    });
    expect(error).toBe("invalid models JSON");
    expect(ops).toEqual([]);
  });

  it("reports a non-array models value", () => {
    const { ops, error } = opsFor("p", undefined, {
      apiKeyEnv: "", api: "openai-compatible", baseURL: "", displayName: "", models: "\"text\"",
    });
    expect(error).toBe("models must be an array");
    expect(ops).toEqual([]);
  });
});

describe("stringOf", () => {
  it("passes strings through and treats others as unset", () => {
    expect(stringOf("x")).toBe("x");
    expect(stringOf(1)).toBeUndefined();
    expect(stringOf(undefined)).toBeUndefined();
    expect(stringOf(null)).toBeUndefined();
  });
});
