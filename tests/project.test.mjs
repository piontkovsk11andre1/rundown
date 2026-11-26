import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime, loadCommands } from "../sources/index.mjs";
import { findProject, projectPath } from "../sources/Project.mjs";
import {
  initProject,
  connectCatalog,
  checkProject,
} from "../sources/Authoring.mjs";
import { runProcess } from "../sources/Process.mjs";
import { workspace, commandFile } from "./helpers.mjs";
import { NodeFilesystem } from "@p10i/do-md";

const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
const manifest = (rundown) =>
  JSON.stringify({ private: true, type: "module", rundown });

test("manifest paths resolve from the package while command paths keep the invocation cwd", async (t) => {
  const cwd = await workspace(t, {
    "package.json": manifest({
      commands: "./automation space/命令.md",
      tests: "./specs",
    }),
    "automation space/命令.md": commandFile(
      "return {file: args.file, cwd: context.workdir};",
      {
        parameters:
          "| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |\n| file | path | yes | | 1 | Input. |",
      },
    ),
    "subdir/keep": "",
  });
  const nested = join(cwd, "subdir");
  assert.equal(findProject(nested).root, cwd);
  assert.equal(projectPath(nested, "tests"), join(cwd, "specs"));
  const runtime = new Runtime(await loadCommands(undefined, { cwd: nested }), {
    cwd: nested,
  });
  t.after(() => runtime.close());
  assert.deepEqual(await runtime.invoke("test", { file: "Input.md" }), {
    file: join(nested, "Input.md"),
    cwd: nested,
  });
});

test("nearest package is a hard boundary and undeclared hidden catalogs are ignored", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": commandFile("return 'parent';"),
    "child/package.json": JSON.stringify({ private: true }),
    "child/.rundown/commands.md": commandFile("return 'must not discover';"),
  });
  await assert.rejects(loadCommands(undefined, { cwd: join(cwd, "child") }), {
    code: "RUNDOWN_DISCOVERY",
  });
  const explicit = await loadCommands("../commands.md", {
    cwd: join(cwd, "child"),
  });
  assert.equal(explicit.commands.size, 1);
});

test("invalid project configuration is diagnosed at the nearest manifest", async (t) => {
  for (const source of [
    "{",
    "[]",
    manifest(null),
    manifest({ commands: "" }),
    manifest({ tests: 42 }),
  ]) {
    const cwd = await workspace(t, { "package.json": source });
    await assert.rejects(loadCommands(undefined, { cwd }), (error) => {
      assert.equal(error.code, "RUNDOWN_PROJECT_CONFIG");
      assert.ok(error.locations[0].source.endsWith("package.json"));
      return true;
    });
  }
});

test("explicit CLI catalogs support execution, help, checks and authoring without a declaration", async (t) => {
  const cwd = await workspace(t, {
    "package.json": JSON.stringify({ private: true }),
    "tools/entry.md": commandFile("return 'explicit';"),
  });
  const cli = (...args) =>
    runProcess(
      process.execPath,
      [bin, "--cwd", cwd, "--commands", "tools/entry.md", ...args],
      { cwd },
    );
  assert.equal((await cli("test")).stdout, "explicit\n");
  assert.match((await cli("help", "test")).stdout, /test/);
  assert.equal(JSON.parse((await cli("--check", "--json")).stdout).ok, true);
  await cli("--new-command", "extra");
  assert.equal((await cli("extra")).stdout, "extra is ready.\n");
  await writeFile(
    join(cwd, "copied.md"),
    commandFile("return 7;", { name: "copied" }),
  );
  await connectCatalog("copied.md", { cwd, commands: "tools/entry.md" });
  assert.equal(
    (await loadCommands("tools/entry.md", { cwd })).commands.size,
    3,
  );
  assert.equal(
    (await checkProject({ cwd, commands: "tools/entry.md" })).ok,
    true,
  );
});

test("registration uses the nearest package and preserves scripts and dependency declarations", async (t) => {
  const original = {
    name: "existing",
    type: "commonjs",
    scripts: { build: "custom build" },
    devDependencies: { "@p10i/rundown": "^2.0.0-rc.1" },
    custom: { keep: true },
  };
  const cwd = await workspace(t, {
    "package.json":
      JSON.stringify(original, null, 4).replaceAll("\n", "\r\n") + "\r\n",
    "nested/keep": "",
    "commands.md": commandFile("return 1;"),
    "tests/.keep": "",
  });
  const initialized = await initProject("../commands.md", {
    cwd: join(cwd, "nested"),
    tests: "../tests",
  });
  assert.equal(initialized.created.length, 0);
  assert.deepEqual(initialized.updated, [join(cwd, "package.json")]);
  const source = await readFile(join(cwd, "package.json"), "utf8");
  const updated = JSON.parse(source);
  assert.deepEqual(
    { ...updated, rundown: undefined },
    { ...original, rundown: undefined },
  );
  assert.deepEqual(updated.rundown, {
    commands: "./commands.md",
    tests: "./tests",
  });
  assert.match(source, /\r\n {4}"/);
  assert.deepEqual(
    (await initProject("../commands.md", { cwd: join(cwd, "nested") })).updated,
    [],
  );
  assert.equal(await readFile(join(cwd, "package.json"), "utf8"), source);
  await assert.rejects(access(join(cwd, ".rundown")));
});

test("registration validation preserves metadata and concurrent registrations never overwrite newer revisions", async (t) => {
  const cwd = await workspace(t, {
    "package.json": manifest({ tests: "./specs" }),
    "commands.md": commandFile("return 1;"),
  });
  const original = await readFile(join(cwd, "package.json"), "utf8");
  await assert.rejects(initProject("missing.md", { cwd }), {
    code: "RUNDOWN_RESOLUTION",
  });
  assert.equal(await readFile(join(cwd, "package.json"), "utf8"), original);
  const fresh = await workspace(t, {
    "package.json": JSON.stringify({ private: true }),
    "commands.md": commandFile("return 1;"),
  });
  const results = await Promise.allSettled([
    initProject("commands.md", { cwd: fresh }),
    initProject("commands.md", { cwd: fresh }),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  for (const result of results)
    if (result.status === "rejected")
      assert.ok(
        ["DO_MD_CONFLICT", "RUNDOWN_AUTHORING_CONFLICT"].includes(
          result.reason.code,
        ),
      );
  assert.equal(
    (await loadCommands(undefined, { cwd: fresh })).commands.size,
    1,
  );
});

test("tests-only packages discover configured tests from nested directories", async (t) => {
  const cwd = await workspace(t, {
    "package.json": manifest({ tests: "./specs" }),
    "specs/ok.test.md":
      "# Tests\n\n## Method: ok\n\nPass.\n\n### Parameters\n\n| Name | Type | Required | Default | Description |\n| --- | --- | --- | --- | --- |\n\n### Returns\n\n| Type | Description |\n| --- | --- |\n| `Promise<void>` | Done. |\n\n### Implementation\n\n```js\nreturn;\n```\n",
  });
  await mkdir(join(cwd, "nested"));
  const result = await runProcess(
    process.execPath,
    [bin, "--cwd", join(cwd, "nested"), "--test", "--json"],
    { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(JSON.parse(result.stdout).ok, true);
  await assert.rejects(loadCommands(undefined, { cwd }), {
    code: "RUNDOWN_DISCOVERY",
  });
});

test("registration never overwrites a concurrent manifest edit or reports partial source creation", async (t) => {
  const cwd = await workspace(t, {
    "package.json": JSON.stringify({ private: true, description: "original" }),
    "commands.md": commandFile("return 1;"),
  });
  const file = join(cwd, "package.json");
  const original = NodeFilesystem.prototype.writeFileAtomicAsync;
  const edited = JSON.stringify({
    private: true,
    description: "concurrent user edit",
  });
  let changed = false;
  NodeFilesystem.prototype.writeFileAtomicAsync = async function (
    path,
    content,
    options,
  ) {
    if (!changed && path === file) {
      changed = true;
      await writeFile(file, edited);
    }
    return original.call(this, path, content, options);
  };
  try {
    await assert.rejects(initProject("commands.md", { cwd }), (error) => {
      assert.equal(error.code, "DO_MD_CONFLICT");
      assert.ok(
        !error.related?.some(
          (item) => item.code === "RUNDOWN_AUTHORING_PARTIAL",
        ),
      );
      return true;
    });
    assert.equal(await readFile(file, "utf8"), edited);
    await access(join(cwd, "commands.md"));
  } finally {
    NodeFilesystem.prototype.writeFileAtomicAsync = original;
  }
});
