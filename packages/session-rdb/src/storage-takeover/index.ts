/**
 * storages 接管的装配入口：在 session-rdb 插件内注册
 *
 * 1. storage hub 的 `rdb` KV 后端——上游 `storage-domain` 的 `StorageBackend.kv`
 *    契约实现（名字来自上游），把 workspace 域映射到 rdb 语义专用表；
 * 2. `ctx.sessionProjectionCache` 服务——替换上游 `session-projection-cache`
 *    插件，直接读写 rdb 的投影 checkpoint 表。
 *
 * 两者都经 `ctx.inject` 挂在可选依赖上：装配里缺 `storage` 或
 * `sessionProjections`（纯 cordis 单测）时静默跳过，消费者按上游的缺服务
 * 路径降级。
 */

import type { Context } from "@deepseek-ai/cordis";
import { storageBackendServiceKey } from "@deepseek-ai/dsh-storage";
import type { ProjectionCacheConfig } from "./projection-cache.ts";
import { SessionProjectionCacheRdb } from "./projection-cache.ts";
import { RDB_STORAGE_BACKEND, RdbStorageBackend } from "./storage-backend.ts";
import type { StorageRepository } from "./types.ts";

/** 装配参数。 */
export interface StorageTakeoverOptions {
  /** storages 接管表访问层（与事件日志同介质）。 */
  repository: StorageRepository;
  /** 投影缓存的写节流参数（上游 base 装配的部署值）。 */
  projectionCache: ProjectionCacheConfig;
  /** 介质就绪信号：投影缓存直读介质前必须等到。 */
  ready: Promise<unknown>;
}

/**
 * Install the storages takeover on the session-rdb plugin context.
 * @param ctx - session-rdb plugin context.
 * @param options - repository and projection-cache throttle parameters.
 */
export function installStorageTakeover(ctx: Context, options: StorageTakeoverOptions): void {
  // workspace 域：上游 workspaceRegistry 仍持有服务与内存态，这里只提供它
  // 依赖的 storage-domain 介质（backend 名 `rdb`，由 profile patch 路由）。
  ctx.inject(["storage"], (storageCtx) => {
    const backend = new RdbStorageBackend(options.repository);
    storageCtx.effect(() => {
      const unregister = storageCtx.storage.backend.register(RDB_STORAGE_BACKEND, backend);
      return async () => {
        unregister();
        await backend.close();
      };
    }, "session-rdb.storageBackend");
    storageCtx.provide(storageBackendServiceKey(RDB_STORAGE_BACKEND), backend);
  });

  // 投影 checkpoint：上游插件被禁用后由本服务提供同名 API。
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    new SessionProjectionCacheRdb(
      projectionCtx,
      options.projectionCache,
      options.repository,
      options.ready,
    );
  });
}
