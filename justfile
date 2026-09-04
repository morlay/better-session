mod pg 'packages/session-rdb/tool/pg/justfile'
mod vendor 'vendor/justfile'
mod custom 'apps/dsh-custom/justfile'

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
