import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadModule, loadCommands } from "../sources/index.mjs";
import { checkProject } from "../sources/Authoring.mjs";
import { workspace, moduleFile, commandFile } from "./helpers.mjs";

test("native absolute paths, spaces and Unicode work for catalogs and dependencies", async (t) => {
  const dir = await workspace(t, {
    "child # café.md": moduleFile('return "child";'),
    "native script.mjs": "export const value = 7;",
    "child commands.md": commandFile("return 1;"),
  });
  const markdown = join(dir, "child # café.md"),
    javascript = join(dir, "native script.mjs"),
    catalog = join(dir, "child commands.md");
  const source =
    "# Parent\n\n## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| `" +
    markdown +
    "` | markdown | child | Child. |\n| `" +
    javascript +
    "` | javascript | script | Script. |\n\n" +
    moduleFile("return [await child.run(),script.value];")
      .split("\n")
      .slice(4)
      .join("\n");
  const file = join(dir, "parent.md");
  await writeFile(file, source);
  assert.equal((await checkProject({ file })).ok, true);
  assert.deepEqual(await (await loadModule(file)).run(), ["child", 7]);
  const entry = join(dir, "catalog.md");
  await writeFile(
    entry,
    "# Root\n\n## Connections\n\n| File | Description |\n| --- | --- |\n| `" +
      catalog +
      "` | Native path. |\n",
  );
  assert.equal((await loadCommands(entry)).commands.size, 1);
  assert.equal(
    (await loadModule(pathToFileURL(file))) === (await loadModule(file)),
    true,
  );
});
