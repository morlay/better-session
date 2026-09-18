import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const PATCH_PATH = join(process.cwd(), "packages/preset/dsh-preset/cordis.patch.yml");
const UPSTREAM_BASE_PATCH = join(
  process.cwd(),
  "vendor/deepseek-harness/packages/bundle/base/cordis.patch.yml",
);
const UPSTREAM_WEB_APP_PATCH = join(
  process.cwd(),
  "vendor/deepseek-harness/packages/bundle/web-app/cordis.patch.yml",
);

interface PatchRow {
  id?: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  insert?: { id?: string; name?: string; config?: Record<string, unknown> }[];
}

async function loadPatchRows(path: string): Promise<PatchRow[]> {
  return yaml.load(await readFile(path, "utf8"), { schema: entryListSchema }) as PatchRow[];
}

/**
 * Compose patch layers over an empty root with the include's own patch algorithm —
 * the single `applyEntryPatches` call `boot()` (and `app-boot`'s `composeEntries`)
 * makes for a profile whose root file is `[]`, so a layer's id target resolves
 * against rows an earlier layer inserted.
 */
function composeLayers(layers: PatchRow[][]): PatchRow[] {
  const apply = applyEntryPatches as unknown as (
    data: unknown[],
    patches: unknown[],
    warn: (message: string, ...args: unknown[]) => void,
  ) => unknown[];
  return apply([], structuredClone(layers).flat(), () => {}) as PatchRow[];
}

function rowById(rows: readonly PatchRow[], id: string): PatchRow | undefined {
  return rows.find((row) => row.id === id);
}

const rows = await loadPatchRows(PATCH_PATH);

const inserted = rows.flatMap((row) => row.insert ?? []);

const sandboxRow = inserted.find((row) => row.id === "sandbox-local");

describe("dsh-preset patch wiring", () => {
  it("declares the prompt-reminder row exactly once, on the local plugin", () => {
    const reminders = inserted.filter((row) => row.id === "prompt-reminder");

    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.name).toBe("@morlay/dsh-prompt-reminder");
  });

  it("keeps the deployment persona the reminder keeps in the system prompt", () => {
    const config = rows.find((row) => row.id === "system-prompt")?.config;

    expect(config?.personaPrefix).toBeTruthy();
    expect(config?.personaSuffix).toBeTruthy();
  });

  it("disables the shipped sandbox rows and mounts the replacement in one layer", () => {
    expect(rows.filter((row) => row.disabled === true).map((row) => row.id)).toEqual(
      expect.arrayContaining(["sandbox", "fs-sandbox"]),
    );
    expect(inserted.filter((row) => row.id === "sandbox-local")).toHaveLength(1);
    expect(sandboxRow?.name).toBe("@morlay/dsh-sandbox-local");
  });

  it("disables exactly the shipped rows this deployment turns off", () => {
    const disabled = rows.filter((row) => row.disabled === true).map((row) => row.id);

    expect(disabled).toEqual(["sandbox", "fs-sandbox", "office-to-pdf"]);
  });

  it("disables the office-to-pdf row the shipped web-app bundle inserts", async () => {
    const shipped = composeLayers([await loadPatchRows(UPSTREAM_WEB_APP_PATCH)]);
    const shippedRow = rowById(shipped, "office-to-pdf");

    expect(shippedRow?.name).toBe("@deepseek-ai/dsh-office-to-pdf");
    expect(shippedRow?.disabled).not.toBe(true);

    const composed = composeLayers([await loadPatchRows(UPSTREAM_WEB_APP_PATCH), rows]);

    expect(rowById(composed, "office-to-pdf")?.disabled).toBe(true);
  });

  it("names rows that still exist in the shipped base bundle", async () => {
    const upstreamIds = new Set(
      [...(await readFile(UPSTREAM_BASE_PATCH, "utf8")).matchAll(/^\s*- id: (\S+)$/gm)].map(
        (match) => match[1]!,
      ),
    );

    for (const id of ["sandbox", "fs-sandbox"]) {
      expect(upstreamIds.has(id), `missing upstream row: ${id}`).toBe(true);
    }
  });

  it("carries the deployment sandbox rules on the inserted row", () => {
    const access = sandboxRow?.config?.access;

    expect(typeof access).toBe("string");
    expect(String(access)).toContain("rw {{ env.XDG_CACHE_HOME }}");
    expect(String(access)).toContain("rw {{ env.XDG_DATA_HOME }}");
    expect(String(access)).toContain("-- mise.*.toml");
    expect(String(access)).toContain("-- **/*.pem");
  });

  it("depends on the bundle whose service classes the inserted row mounts", async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "packages/preset/dsh-preset/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.["@morlay/dsh-sandbox-local"]).toBeTruthy();
  });
});
