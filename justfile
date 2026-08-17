mod pg 'packages/session-rdb/tool/pg/justfile'

default:
    just --list

pm *args:
    nub pm {{ args }}

mise *args:
    mise {{ args }}

view *args:
    nub view {{ args }}

dep *args:
    pnpm install {{ args }}

clean:
    rm -f pnpm-lock.yaml;
    rm -rf node_modules;

fmt:
    nub exec oxfmt .

lint:
    nub exec oxlint .

build:
    nub -r run prepare

test:
    nub exec vitest run

export DSH_HOME := join(justfile_directory(), ".dsh-store")

dev *args: build setup-dsh
    pnpm exec dsh --profile web {{ args }}

setup-dsh:
    rm -rf {{ join(DSH_HOME, "profiles/web") }}
    pnpm exec dsh plugin --profile web add ./packages/better-session
    pnpm --dir {{ join(DSH_HOME, "profiles/web") }} add -w \
        link:{{ join(justfile_directory(), "packages/session-branch") }} \
        link:{{ join(justfile_directory(), "packages/session-rdb") }} \
        link:{{ join(justfile_directory(), "packages/ui-conversation-message-actions") }}
    pnpm --dir {{ join(DSH_HOME, "profiles/web") }} install --ignore-scripts --no-frozen-lockfile
