// 服务面（ctx.inputTriggers）：根上只有源名册与按会话解析的控制器，
// 注册 / 注销要传播到每个活跃会话，控制器的生死跟着会话 scope 走。
// 装配：真实 cordis 根上下文 + 上游的客户端 scope 原语（createScope/scopeOf），
// 只有 sessions 服务按最小面提供（scopeOf 是它被用到的唯一方法）。
import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeOf } from "@deepseek-ai/dsh-api-session-controller/src/client/scope.ts";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import { InputTriggerService } from "../client/service.ts";
import type {
  InputTriggerCandidate,
  InputTriggerSource,
  TriggerChar,
  TriggerGuard,
} from "../types.ts";

const sid = (key: string): SessionId => key as SessionId;
const plain: TriggerGuard = { tier: "plain" };
const tick = (): Promise<void> => Promise.resolve();

interface PendingFetch {
  readonly signal: AbortSignal;
  resolve(items: readonly InputTriggerCandidate[]): void;
  reject(error: unknown): void;
}

function deferredSource(
  trigger: TriggerChar,
  name: string,
  over: Partial<InputTriggerSource> = {},
) {
  const pending: PendingFetch[] = [];
  const warm = vi.fn();
  const source: InputTriggerSource = {
    trigger,
    name,
    candidates: (_session, req) =>
      new Promise<readonly InputTriggerCandidate[]>((resolve, reject) => {
        pending.push({ signal: req.signal, resolve, reject });
      }),
    onPick: () => undefined,
    warm,
    ...over,
  };
  return { source, pending, warm };
}

function readySource(trigger: TriggerChar, name: string, items: readonly InputTriggerCandidate[]) {
  const source: InputTriggerSource = {
    trigger,
    name,
    candidates: () => Promise.resolve(items),
    onPick: () => undefined,
  };
  return { source };
}

async function serviceBench() {
  const root = new Context();
  root.provide("sessions", { scopeOf: (ctx: Context) => scopeOf(ctx) });
  await root.plugin(InputTriggerService).await();
  const service = root.get("inputTriggers") as InputTriggerService;
  const mint = (key: string) => {
    const scope = createScope(root, sid(key));
    return { actx: scope.ctx, fiber: scope.fiber };
  };
  return { root, service, mint };
}

describe("registerSource", () => {
  it("同一触发符下的同名源即重复，跨触发符可以共存", async () => {
    const { service } = await serviceBench();
    service.registerSource(readySource("/", "command", []).source);
    expect(() => service.registerSource(readySource("/", "command", []).source)).toThrow(
      /already registered/,
    );
    service.registerSource(readySource("@", "command", []).source);
  });

  it("注销把该源的组从每个活跃会话的菜单里撤下，且名字随即释放", async () => {
    const { service, mint } = await serviceBench();
    const alpha = readySource("/", "alpha", [{ name: "one" }]);
    const beta = deferredSource("/", "beta");
    service.registerSource(alpha.source);
    const disposeBeta = service.registerSource(beta.source);
    const ca = service.sessionOf(mint("a").actx);
    const cb = service.sessionOf(mint("b").actx);

    ca.track("/o", 2, plain, 1);
    cb.track("/o", 2, plain, 1);
    await tick();
    expect(ca.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["alpha", "beta"]);
    expect(cb.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["alpha", "beta"]);

    disposeBeta();
    expect(ca.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["alpha"]);
    expect(cb.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["alpha"]);

    disposeBeta();
    service.registerSource(deferredSource("/", "beta").source);
  });

  it("控制器诞生时预热整个名册，后注册的源也会预热进活跃控制器", async () => {
    const { service, mint } = await serviceBench();
    const cmd = deferredSource("/", "command");
    service.registerSource(cmd.source);
    const ca = service.sessionOf(mint("a").actx);
    const cb = service.sessionOf(mint("b").actx);
    expect(cmd.warm).toHaveBeenCalledTimes(2);
    expect(cmd.warm).toHaveBeenNthCalledWith(1, { sessionId: sid("a") });
    expect(cmd.warm).toHaveBeenNthCalledWith(2, { sessionId: sid("b") });

    const late = deferredSource("/", "late", { lexicon: () => ["fresh"] });
    service.registerSource(late.source);
    expect(late.warm).toHaveBeenCalledWith({ sessionId: sid("a") });
    expect(late.warm).toHaveBeenCalledWith({ sessionId: sid("b") });
    expect(ca.lexicon.getSnapshot().get("/")).toEqual(["fresh"]);
    expect(cb.lexicon.getSnapshot().get("/")).toEqual(["fresh"]);
  });

  it("注册它的 fiber 销毁后源随之移除", async () => {
    const { root, service, mint } = await serviceBench();
    const controller = service.sessionOf(mint("a").actx);
    const fiber = root.plugin({
      apply(pluginCtx: Context) {
        pluginCtx.effect(
          () => service.registerSource(readySource("/", "command", [{ name: "goal" }]).source),
          "test: slash source",
        );
      },
    });
    await fiber.await();
    controller.track("/g", 2, plain, 1);
    await tick();
    expect(controller.menu.getSnapshot().open).toBe(true);

    await fiber.dispose();
    expect(controller.menu.getSnapshot().open).toBe(false);
    controller.track("/g", 2, plain, 1);
    expect(controller.menu.getSnapshot().open).toBe(false);
  });
});

describe("sessionOf", () => {
  it("按 scope 懒解析驻留控制器；非会话上下文抛错", async () => {
    const { root, service, mint } = await serviceBench();
    const a = mint("a");
    const first = service.sessionOf(a.actx);
    expect(service.sessionOf(a.actx)).toBe(first);
    expect(service.sessionOf(mint("b").actx)).not.toBe(first);
    expect(() => service.sessionOf(root)).toThrow(/session scope/);
  });

  it("两个会话互相隔离：一个开菜单不触碰另一个", async () => {
    const { service, mint } = await serviceBench();
    const cmd = deferredSource("/", "command");
    service.registerSource(cmd.source);
    const ca = service.sessionOf(mint("a").actx);
    const cb = service.sessionOf(mint("b").actx);

    ca.track("/g", 2, plain, 1);
    expect(ca.menu.getSnapshot().open).toBe(true);
    expect(cb.menu.getSnapshot().open).toBe(false);

    cmd.pending[0]!.resolve([{ name: "goal" }]);
    await tick();
    expect(ca.menu.getSnapshot().groups[0]!.items).toEqual([{ name: "goal" }]);
    expect(cb.menu.getSnapshot().open).toBe(false);
  });

  it("会话 scope 销毁后控制器失效，重新 mint 得到新的控制器", async () => {
    const { service, mint } = await serviceBench();
    service.registerSource(readySource("/", "command", [{ name: "goal" }]).source);
    const a = mint("a");
    const controller = service.sessionOf(a.actx);
    controller.track("/g", 2, plain, 1);
    await tick();
    expect(controller.menu.getSnapshot().open).toBe(true);

    await a.fiber.dispose();
    expect(controller.menu.getSnapshot().open).toBe(false);
    controller.track("/g", 2, plain, 1);
    expect(controller.menu.getSnapshot().open).toBe(false);
    expect(service.sessionOf(mint("a").actx)).not.toBe(controller);
  });

  it("语言切换时重取每个打开菜单的候选，关闭的控制器不动", async () => {
    const { root, service, mint } = await serviceBench();
    let mark = "en";
    const candidates = vi.fn(() => Promise.resolve([{ name: "compact", description: mark }]));
    service.registerSource({
      trigger: "/",
      name: "command",
      candidates,
      onPick: () => undefined,
    });
    const first = service.sessionOf(mint("a").actx);
    const second = service.sessionOf(mint("b").actx);
    const closed = service.sessionOf(mint("c").actx);
    first.track("/c", 2, plain, 1);
    second.track("/c", 2, plain, 1);
    await tick();
    expect(candidates).toHaveBeenCalledTimes(2);

    mark = "zh";
    root.emit("locale/change", {} as never);
    await tick();
    expect(candidates).toHaveBeenCalledTimes(4);
    expect(first.menu.getSnapshot().groups[0]!.items).toEqual([
      { name: "compact", description: "zh" },
    ]);
    expect(second.menu.getSnapshot().groups[0]!.items).toEqual([
      { name: "compact", description: "zh" },
    ]);
    expect(closed.menu.getSnapshot().open).toBe(false);
  });
});
