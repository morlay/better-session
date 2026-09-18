import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_SKILLS_DIR, prepareOfficeSkillAssets } from "../cli/office-assets.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-office-assets-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareOfficeSkillAssets", () => {
  it("copies the assets tree next to the primary runtime", async () => {
    const root = await tempRoot();
    const source = join(root, "assets");
    await mkdir(join(source, "scripts"), { recursive: true });
    await mkdir(join(source, "office-docx"), { recursive: true });
    await writeFile(join(source, "scripts", "check_office.py"), "print('ok')\n");
    await writeFile(join(source, "office-docx", "template.docx"), "binary\n");
    const destination = join(root, "runtime", OFFICE_SKILLS_DIR);

    await prepareOfficeSkillAssets(source, destination);

    expect(await readFile(join(destination, "scripts", "check_office.py"), "utf8")).toBe(
      "print('ok')\n",
    );
    expect(await readFile(join(destination, "office-docx", "template.docx"), "utf8")).toBe(
      "binary\n",
    );
  });

  it("fails when the structure check script is missing", async () => {
    const root = await tempRoot();
    const source = join(root, "assets");
    await mkdir(source, { recursive: true });
    const destination = join(root, "runtime", OFFICE_SKILLS_DIR);

    await expect(prepareOfficeSkillAssets(source, destination)).rejects.toThrow();
  });
});
