// 视图选择、上下文占用与图片文案：会话外壳上的纯投影（无 DOM）。
import type { Translate } from "@deepseek-ai/dsh-client-ui-slots";
import { describe, expect, it } from "vitest";
import { contextOccupancy } from "../client/context-occupancy.ts";
import type { ConversationKey } from "../client/locales.ts";
import { attachmentErrorText, imageSizeText } from "../client/image-labels.ts";
import { resolveActiveView } from "../client/view-selection.ts";

type TranslateCall = { key: string; params: unknown };

function translateSpy(): { t: Translate<ConversationKey>; calls: TranslateCall[] } {
  const calls: TranslateCall[] = [];
  const t = ((key: string, params?: unknown) => {
    calls.push({ key, params });
    return key;
  }) as unknown as Translate<ConversationKey>;
  return { t, calls };
}

describe("contextOccupancy", () => {
  it("没有占用投影时给出空值", () => {
    expect(contextOccupancy(undefined)).toBeNull();
    expect(contextOccupancy({ pressureTokens: 100 } as never)).toBeNull();
  });

  it("优先用投影后的 token 数，并按窗口取整百分比", () => {
    expect(
      contextOccupancy({
        projectedTokens: 5000,
        pressureTokens: 9000,
        contextWindow: 20000,
      } as never),
    ).toEqual({ percent: 25, usedTokens: 5000, contextWindow: 20000 });
  });

  it("没有投影值时可退回压力值", () => {
    expect(contextOccupancy({ pressureTokens: 3000, contextWindow: 12000 } as never)).toEqual({
      percent: 25,
      usedTokens: 3000,
      contextWindow: 12000,
    });
  });

  it("超过窗口时封顶 100%", () => {
    expect(
      contextOccupancy({ projectedTokens: 30000, contextWindow: 20000 } as never)?.percent,
    ).toBe(100);
  });
});

describe("resolveActiveView", () => {
  const tabs = [
    { id: "chat", label: "对话" },
    { id: "trajectory", label: "轨迹" },
  ];

  it("选中已知视图时用它", () => {
    expect(resolveActiveView(tabs, "trajectory")?.id).toBe("trajectory");
  });

  it("未选中或选中未知视图时回退到默认对话视图", () => {
    expect(resolveActiveView(tabs, null)?.id).toBe("chat");
    expect(resolveActiveView(tabs, "gone")?.id).toBe("chat");
  });

  it("没有默认对话视图且未命中时给出空值", () => {
    const others = [{ id: "trajectory", label: "轨迹" }];
    expect(resolveActiveView(others, null)).toBeUndefined();
    expect(resolveActiveView(others, "trajectory")?.id).toBe("trajectory");
    expect(resolveActiveView([], null)).toBeUndefined();
  });
});

describe("imageSizeText", () => {
  it("整兆显示整数，非整兆保留一位小数", () => {
    expect(imageSizeText(1024 * 1024)).toBe("1MB");
    expect(imageSizeText(4 * 1024 * 1024)).toBe("4MB");
    expect(imageSizeText(1.5 * 1024 * 1024)).toBe("1.5MB");
    expect(imageSizeText(0)).toBe("0MB");
  });
});

describe("attachmentErrorText", () => {
  const limits = {
    maxImageDimension: 8000,
    maxImagesPerMessage: 5,
    maxImageBytes: 4 * 1024 * 1024,
    maxMessageImageBytes: 8 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    mediaTypes: ["image/png"] as const,
  };

  it("模型不支持图片与文件未上传各自有专属文案", () => {
    const { t, calls } = translateSpy();
    expect(attachmentErrorText(t, "MODEL_DOES_NOT_SUPPORT_IMAGES")).toBe("image.modelUnsupported");
    expect(attachmentErrorText(t, "FILE_NOT_STAGED")).toBe("file.notStaged");
    expect(calls.map((call) => call.key)).toEqual(["image.modelUnsupported", "file.notStaged"]);
  });

  it("带限制的失败把限制值填进文案", () => {
    const { t, calls } = translateSpy();
    expect(attachmentErrorText(t, "IMAGE_DIMENSION_TOO_LARGE", limits)).toBe(
      "image.dimensionTooLarge",
    );
    expect(attachmentErrorText(t, "TOO_MANY_IMAGES", limits)).toBe("image.tooMany");
    expect(attachmentErrorText(t, "IMAGE_TOO_LARGE", limits)).toBe("image.fileTooLarge");
    expect(attachmentErrorText(t, "IMAGES_TOO_LARGE", limits)).toBe("image.totalTooLarge");

    expect(calls.map((call) => call.params)).toEqual([
      { size: 8000 },
      { count: 5 },
      { size: "4MB" },
      { size: "8MB" },
    ]);
  });

  it("缺少限制值时退回通用发送失败文案并带上原因", () => {
    const { t, calls } = translateSpy();
    expect(attachmentErrorText(t, "IMAGE_TOO_LARGE")).toBe("image.sendFailed");
    expect(calls).toEqual([{ key: "image.sendFailed", params: { reason: "IMAGE_TOO_LARGE" } }]);
  });

  it("未知原因与图片类型不匹配都归到对应文案", () => {
    const { t, calls } = translateSpy();
    expect(attachmentErrorText(t, "IMAGE_TYPE_MISMATCH")).toBe("image.unsupportedType");
    expect(attachmentErrorText(t, "WHAT_IS_THIS")).toBe("image.sendFailed");
    expect(calls[0]?.key).toBe("image.unsupportedType");
  });
});
