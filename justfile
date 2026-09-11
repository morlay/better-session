mod vendor 'vendor/justfile'
mod pg 'packages/session/session-rdb/tool/pg/justfile'
mod custom 'apps/dsh-custom-next/justfile'

default:
    just --list

mise *args:
    mise {{ args }}

view *args:
    pnpm view {{ args }}

dep *args:
    pnpm install {{ args }}

update:
    pnpm dlx -r --filter './packages/*' taze latest -w

clean:
    rm -f pnpm-lock.yaml;
    pnpm clean

fmt:
    pnpm exec oxfmt .

lint:
    pnpm exec oxlint .

publish:
    pnpm -r --filter './packages/*' exec tsx {{ justfile_directory() }}/scripts/publish-if-need.mts

build *args:
    @pnpm -r --filter './packages/*' run build {{ args }}

version *args:
    pnpm -r --filter './packages/*' version {{ args }}

test:
    pnpm exec vitest run

# 显式导入旧 $DSH_HOME/storages JSON 到 session-rdb 专用表（先停掉 dsh）。
# 例：just import-storages --dsh-home apps/dsh-custom-next/.dsh-store \
# --path apps/dsh-custom-next/.dsh-store/sessions/sessions.sqlite
import-storages *args:
    pnpm exec tsx packages/session-rdb/tool/import-storages.ts {{ args }}
