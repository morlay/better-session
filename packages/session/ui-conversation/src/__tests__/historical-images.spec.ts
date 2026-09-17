// @vitest-environment jsdom
// 历史图片缓存：撤回 / 重试后历史里的图片要按会话作用域缓存与失效，避免每次渲染重读。
import { Context } from "@deepseek-ai/cordis";
import type { ISessions, SessionBinding } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HistoricalImageCache } from "../client/conversation/historical-images.ts";

const SID = "s1" as SessionId;
const OTHER = "s2" as SessionId;

/** 字节 01 02 03 的 base64 是 AQID（手算真值）。 */
const CANONICAL = "data:image/png;base64,AQID";
const SEEDED = "data:image/png;base64,SEED";

// 运行环境没有可用的 objectURL（jsdom 的 Blob 与 node 的 URL 不互通）：
// 固定走实现里的 data: 降级路径。
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", { value: undefined, configurable: true });
});

const IMAGE = {
  attachmentId: "att-1",
  mediaType: "image/png",
  bytes: 3,
} as never;

const OTHER_IMAGE = {
  attachmentId: "att-2",
  mediaType: "image/png",
  bytes: 3,
} as never;

function bench(options: { ok?: boolean } = {}) {
  const scope = new Context();
  const readAttachment = vi.fn(async () =>
    options.ok === false
      ? { ok: false, error: { code: "attachment/not-found", message: "没有这张图" } }
      : {
          ok: true,
          value: {
            attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 3 },
            data: Uint8Array.of(1, 2, 3),
          },
        },
  );
  const binding = {
    sessionId: SID,
    session: { readAttachment },
    ctx: scope,
  } as unknown as SessionBinding;
  const sessions = {
    binding: (id: SessionId) => (id === SID ? binding : undefined),
  } as unknown as ISessions;
  const ctx = new Context();
  const cache = new HistoricalImageCache(ctx, sessions);
  return { cache, readAttachment, scope, ctx };
}

describe("HistoricalImageCache", () => {
  it("同一个引用的第二次请求复用第一次的加载", async () => {
    const { cache, readAttachment } = bench();
    const first = cache.resolve(SID, IMAGE);
    const second = cache.resolve(SID, IMAGE);

    expect(second).toBe(first);
    const url = await first;
    expect(url).toBe(CANONICAL);
    expect(readAttachment).toHaveBeenCalledTimes(1);
    expect(cache.peek(SID, IMAGE)).toBe(url);
  });

  it("不同引用各自加载", async () => {
    const { cache, readAttachment } = bench();
    await cache.resolve(SID, IMAGE);
    await cache.resolve(SID, OTHER_IMAGE);

    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it("未知会话直接失败", async () => {
    const { cache } = bench();
    await expect(cache.resolve(OTHER, IMAGE)).rejects.toThrow(/unknown session/u);
    expect(cache.peek(OTHER, IMAGE)).toBeUndefined();
  });

  it("读取失败后条目被清理，下一次请求重新加载", async () => {
    const { cache, readAttachment } = bench({ ok: false });
    await expect(cache.resolve(SID, IMAGE)).rejects.toThrow(/没有这张图/u);
    expect(cache.peek(SID, IMAGE)).toBeUndefined();

    await expect(cache.resolve(SID, IMAGE)).rejects.toThrow(/没有这张图/u);
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it("预置的图片地址立即可读，并被规范加载替换", async () => {
    const { cache, readAttachment } = bench();
    expect(cache.seed(SID, IMAGE, SEEDED)).toBe(true);
    expect(cache.peek(SID, IMAGE)).toBe(SEEDED);

    await expect(cache.resolve(SID, IMAGE)).resolves.toBe(CANONICAL);
    expect(readAttachment).toHaveBeenCalledTimes(1);
  });

  it("同一条目已存在时预置被拒绝", async () => {
    const { cache } = bench();
    await cache.resolve(SID, IMAGE);

    expect(cache.seed(SID, IMAGE, SEEDED)).toBe(false);
  });

  it("会话作用域释放后缓存失效并重新加载", async () => {
    const { cache, readAttachment, scope } = bench();
    await cache.resolve(SID, IMAGE);
    expect(cache.peek(SID, IMAGE)).toBeDefined();

    await scope.fiber.dispose();

    expect(cache.peek(SID, IMAGE)).toBeUndefined();
    await cache.resolve(SID, IMAGE);
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it("缓存自身释放后拒绝新请求", async () => {
    const { cache, ctx } = bench();
    await cache.resolve(SID, IMAGE);

    await ctx.fiber.dispose();

    await expect(cache.resolve(SID, IMAGE)).rejects.toThrow(/disposed/u);
    expect(cache.seed(SID, IMAGE, SEEDED)).toBe(false);
  });
});
