import { access, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Host 约定的 Office 资源目录名，与 `primary-runtime` 同级（见上游 `apps/desktop-host/src/office.ts`）。 */
export const OFFICE_SKILLS_DIR = "office-skills";

/**
 * Resolve the `@deepseek-ai/dsh-skill-office` assets directory.
 * @returns Absolute assets path inside the installed skill package.
 */
export function officeSkillAssetsSource(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@deepseek-ai/dsh-skill-office/package.json")), "assets");
}

/**
 * Copy the Office skill assets into the Host's sibling directory and fail when the
 * structure check script is missing. The bundled host variant loads no office skills,
 * so these assets are shipped for later use rather than read at startup; the check keeps
 * the payload honest about what `@deepseek-ai/dsh-skill-office` needs.
 * @param source - `@deepseek-ai/dsh-skill-office` assets directory.
 * @param destination - `office-skills` directory next to the primary runtime payload.
 */
export async function prepareOfficeSkillAssets(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, dereference: true });
  await access(join(destination, "scripts", "check_office.py"));
}
