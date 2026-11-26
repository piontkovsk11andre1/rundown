import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { loadModule, loadCommands, Runtime } from "../sources/index.mjs";
import { createView } from "../sources/Views.mjs";
import {
  checkProject,
  connectCatalog,
  initProject,
  newCommand,
} from "../sources/Authoring.mjs";
import { workspace, moduleFile, commandFile } from "./helpers.mjs";
import { fileURLToPath } from "node:url";
import { runProcess } from "../sources/Process.mjs";

async function project(t) {
  const module = moduleFile('return "from package";');
  return workspace(t, {
    "package.json": JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@review/recipes": "1.0.0" },
      rundown: { commands: "./entry.md" },
    }),
    "entry.md": "# Local commands\n",
    "consumer.md": moduleFile("return recipe.run();").replace(
      "## Method:",
      "## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| npm:@review/recipes/module | markdown | recipe | Shared logic. |\n\n## Method:",
    ),
    "node_modules/@review/recipes/package.json": JSON.stringify({
      name: "@review/recipes",
      version: "1.0.0",
      type: "module",
      exports: {
        "./module": "./module.md",
        "./commands": "./catalog.md",
        "./view": "./report.md.template",
        "./tests": "./tests",
      },
    }),
    "node_modules/@review/recipes/module.md": module,
    "node_modules/@review/recipes/catalog.md": commandFile(
      'const recipe=await rundown.loadModule("./module.md");return recipe.run();',
      { name: "shared" },
    ),
    "node_modules/@review/recipes/report.md.template":
      "# Package report\n\n{% doc.write(ctx.data.title); %}\n",
    "node_modules/@review/recipes/private.md": module,
    "node_modules/@review/recipes/tests/ok.test.md": moduleFile("return;"),
  });
}

test("explicit npm: references use package exports for modules, dependencies and templates", async (t) => {
  const cwd = await project(t);
  const direct = await loadModule("npm:@review/recipes/module", { cwd });
  assert.equal(
    direct,
    await loadModule("./node_modules/@review/recipes/module.md", { cwd }),
  );
  assert.equal(await direct.run(), "from package");
  const consumer = await loadModule("./consumer.md", { cwd });
  assert.equal(await consumer.run(), "from package");
  assert.equal((await checkProject({ cwd, file: "consumer.md" })).ok, true);
  const view = await createView(
    "npm:@review/recipes/view",
    { title: "Shared view" },
    { cwd },
  );
  assert.match(view.render(), /Shared view/);
  view.close();
  await assert.rejects(
    loadModule("npm:@review/recipes/private.md", { cwd }),
    (error) =>
      error.code === "RUNDOWN_RESOLUTION" &&
      error.cause?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  await assert.rejects(
    loadModule("npm:@review/recipes/module#fresh", { cwd }),
    { code: "RUNDOWN_RESOLUTION" },
  );
});

test("package catalogs connect through stable export specifiers and share normal identity", async (t) => {
  const cwd = await project(t);
  const direct = await loadCommands("npm:@review/recipes/commands", { cwd });
  assert.equal(direct.commands.size, 1);
  await connectCatalog("npm:@review/recipes/commands", { cwd });
  const before = await readFile(cwd + "/entry.md", "utf8");
  assert.match(before, /npm:@review\/recipes\/commands/);
  assert.equal(
    (await connectCatalog("npm:@review/recipes/commands", { cwd })).updated
      .length,
    0,
  );
  assert.equal(await readFile(cwd + "/entry.md", "utf8"), before);
  assert.equal((await checkProject({ cwd })).ok, true);
  const runtime = new Runtime(await loadCommands(undefined, { cwd }), { cwd });
  t.after(() => runtime.close());
  assert.equal(await runtime.invoke("shared"), "from package");
});

test("registration preserves package references and authoring requires a local destination", async (t) => {
  const cwd = await project(t);
  await initProject("npm:@review/recipes/commands", {
    cwd,
    tests: "npm:@review/recipes/tests",
  });
  const configured = await readFile(cwd + "/package.json", "utf8");
  assert.deepEqual(JSON.parse(configured).rundown, {
    commands: "npm:@review/recipes/commands",
    tests: "npm:@review/recipes/tests",
  });
  assert.deepEqual(
    (
      await initProject("npm:@review/recipes/commands", {
        cwd,
        tests: "npm:@review/recipes/tests",
      })
    ).updated,
    [],
  );
  assert.equal((await loadCommands(undefined, { cwd })).commands.size, 1);
  const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
  const tested = await runProcess(
    process.execPath,
    [bin, "--cwd", cwd, "--test", "--json"],
    { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(JSON.parse(tested.stdout).ok, true);
  await assert.rejects(newCommand("local", { cwd }), /local catalog/);
  await assert.rejects(connectCatalog("./entry.md", { cwd }), /local catalog/);
  assert.equal(await readFile(cwd + "/package.json", "utf8"), configured);
  const invalid = JSON.parse(configured);
  invalid.rundown.commands = "npm:@review/recipes/private.md";
  await writeFile(cwd + "/package.json", JSON.stringify(invalid));
  await assert.rejects(
    loadCommands(undefined, { cwd }),
    (error) =>
      error.code === "RUNDOWN_RESOLUTION" &&
      error.locations.some((location) =>
        location.source.endsWith("package.json"),
      ),
  );
});
