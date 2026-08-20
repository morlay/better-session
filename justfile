mod pg 'packages/session-rdb/tool/pg/justfile'

default:
    just --list

pm *args:
    pnpm pm {{ args }}

mise *args:
    mise {{ args }}

view *args:
    pnpm view {{ args }}

dep *args:
    pnpm install {{ args }}

update:
    pnpm dlx taze -w -r latest

clean:
    rm -f pnpm-lock.yaml;
    find . \
        -type d \
        -name "node_modules" \
        -prune -print -exec rm -rf '{}' \;

fmt:
    pnpm exec oxfmt .

lint:
    pnpm exec oxlint .

build *args:
    @pnpm exec turbo run prepare {{ args }}

test:
    pnpm exec vitest run

export DSH_HOME := join(justfile_directory(), ".dsh-store")

dev *args: build setup-dsh
    pnpm exec dsh --profile web {{ args }}

setup-dsh:
    rm -rf {{ join(DSH_HOME, "profiles/web") }}
    pnpm exec dsh plugin --profile web add @morlay/better-session@link:{{ join(justfile_directory(), "./packages/better-session") }}
    pnpm --dir {{ join(DSH_HOME, "profiles/web") }} add -w \
        @morlay/session-branch@link:{{ join(justfile_directory(), "packages/session-branch") }} \
        @morlay/session-rdb@link:{{ join(justfile_directory(), "packages/session-rdb") }} \
        @morlay/ui-conversation-message-actions@link:{{ join(justfile_directory(), "packages/ui-conversation-message-actions") }}
    pnpm --dir {{ join(DSH_HOME, "profiles/web") }} install --ignore-scripts --no-frozen-lockfile
