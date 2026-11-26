import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../sources/Process.mjs";
import {
  initProject,
  connectCatalog,
  checkProject,
} from "../sources/Authoring.mjs";
import {
  workspace,
  commandFile,
  moduleFile,
  copyGreeting,
} from "./helpers.mjs";

test("copied catalogs connect idempotently without replacing their files", async (t) => {
  const cwd = await workspace(t, {
    "copied.md": commandFile('return "copied";', { name: "copied" }),
  });
  await copyGreeting(cwd);
  await initProject("commands.md", { cwd });
  const source = await readFile(join(cwd, "copied.md"), "utf8");
  const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
  const connected = await runProcess(process.execPath, [
    bin,
    "--cwd",
    cwd,
    "--connect",
    "copied.md",
    "--json",
  ]);
  assert.equal(JSON.parse(connected.stdout).updated.length, 1);
  assert.equal(
    (await runProcess(process.execPath, [bin, "--cwd", cwd, "copied"])).stdout,
    "copied\n",
  );
  const root = await readFile(join(cwd, "commands.md"), "utf8");
  assert.equal((await connectCatalog("copied.md", { cwd })).updated.length, 0);
  assert.equal(await readFile(join(cwd, "commands.md"), "utf8"), root);
  assert.equal(await readFile(join(cwd, "copied.md"), "utf8"), source);
  assert.equal((await checkProject({ cwd })).commands.length, 2);
});
test("connection validation rejects duplicate names, cycles and module documents before publication", async (t) => {
  const cwd = await workspace(t, {
    "duplicate.md": commandFile("return 1;", { name: "example" }),
    "module.md": moduleFile("return 1;"),
  });
  await copyGreeting(cwd);
  await initProject("commands.md", { cwd });
  const root = join(cwd, "commands.md"),
    before = await readFile(root, "utf8");
  await assert.rejects(
    connectCatalog("duplicate.md", { cwd }),
    /graph invalid/,
  );
  await assert.rejects(
    connectCatalog("module.md", { cwd }),
    /command catalogs/,
  );
  await writeFile(
    join(cwd, "cycle.md"),
    "# Cycle\n\n## Connections\n\n| File | Description |\n| --- | --- |\n| ./commands.md | Parent. |\n",
  );
  await assert.rejects(connectCatalog("cycle.md", { cwd }), /graph invalid/);
  assert.equal(await readFile(root, "utf8"), before);
});
