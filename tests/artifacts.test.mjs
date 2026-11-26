import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadCommands,
  loadModule,
  Runtime,
  diagnostic,
  compileFile,
} from "../sources/index.mjs";
import { checkProject } from "../sources/Authoring.mjs";
import { workspace, commandFile, moduleFile } from "./helpers.mjs";

test("catalog code and metadata retain one cached source artifact", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": commandFile('return "old implementation";', { name: "old" }),
  });
  const entry = join(cwd, "commands.md");
  const first = await loadCommands(entry);
  first.commands.get("old").description = "caller-owned metadata";
  await writeFile(
    entry,
    commandFile('return "new implementation";', { name: "new" }),
  );
  const second = await loadCommands(entry);
  assert.deepEqual([...second.commands.keys()], ["old"]);
  assert.notEqual(
    second.commands.get("old").description,
    "caller-owned metadata",
  );
  const runtime = new Runtime(second);
  try {
    assert.equal(await runtime.invoke("old"), "old implementation");
  } finally {
    await runtime.close();
  }
  const checked = await checkProject({ file: entry, kind: "commands" });
  assert.equal(checked.ok, true);
  assert.equal(checked.commands[0].name, "new");
  assert.deepEqual([...(await loadCommands(entry)).commands.keys()], ["old"]);
});

test("checking and compile-only never replace a loaded executable's source map", async (t) => {
  const cwd = await workspace(t, {
    "module.md": moduleFile('throw new Error("old failure");'),
  });
  const file = join(cwd, "module.md");
  const module = await loadModule(file);
  async function failure() {
    try {
      await module.run();
      assert.fail("Must throw");
    } catch (error) {
      return diagnostic(error);
    }
  }
  const before = await failure();
  assert.ok(
    before.locations.some((location) =>
      location.snippet.includes("old failure"),
    ),
  );
  await writeFile(
    file,
    moduleFile('throw new Error("new failure");', {
      description: Array(30).fill("New documentation.").join("\n"),
    }),
  );
  compileFile(pathToFileURL(file));
  assert.equal((await checkProject({ file })).ok, true);
  assert.deepEqual((await failure()).locations, before.locations);
});

test("JSON constants and defaults preserve special keys, nested values and signed zero", async (t) => {
  const data =
    '{"__proto__":{"marker":"own value"},"nested":[{"__proto__":{"x":1}}],"text":"*/ \\u2028","number":-0}';
  const parameters =
    "| Name | Type | Required | Default | Description |\n| --- | --- | --- | --- | --- |\n| config | object | no | `" +
    data +
    "` | Data. |\n| zero | number | no | `-0` | Signed zero. |";
  const source = moduleFile(
    "return {constant:settings,parameter:config,signed:Object.is(zero,-0)};",
    { parameters },
  ).replace(
    "## Method: run",
    "## Constants\n\n| Name | Value | Description |\n| --- | --- | --- |\n| settings | `" +
      data +
      "` | Data. |\n\n## Method: run",
  );
  const cwd = await workspace(t, { "module.md": source });
  const result = await (await loadModule(join(cwd, "module.md"))).run();
  assert.deepEqual(result.constant, JSON.parse(data));
  assert.deepEqual(result.parameter, JSON.parse(data));
  assert.equal(result.signed, true);
  assert.equal(Object.getPrototypeOf(result.constant), Object.prototype);
  assert.equal(Object.hasOwn(result.constant, "__proto__"), true);
});

test("non-finite JSON literals are rejected with document diagnostics", async (t) => {
  const source = moduleFile("return value;").replace(
    "## Method: run",
    "## Constants\n\n| Name | Value | Description |\n| --- | --- | --- |\n| value | 1e999 | Invalid number. |\n\n## Method: run",
  );
  const cwd = await workspace(t, { "module.md": source });
  await assert.rejects(loadModule(join(cwd, "module.md")), /finite/);
});
