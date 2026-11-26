import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  readdir,
  access,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeFilesystem } from "@p10i/do-md";
import { initProject } from "../sources/Authoring.mjs";
import { runProcess } from "../sources/Process.mjs";
import { workspace, commandFile, moduleFile } from "./helpers.mjs";

const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
const cli = (cwd, ...args) =>
  runProcess(process.execPath, [bin, "--cwd", cwd, ...args], { cwd });

test("bare init prints registration usage without reading or writing a manifest", async (t) => {
  const cwd = await workspace(t, { "Notes.md": "Keep me." });
  const result = await cli(cwd, "--init");
  assert.match(result.stdout, /--init <catalog.md>/);
  assert.deepEqual(await readdir(cwd), ["Notes.md"]);
});

test("CLI registers existing catalog/test paths and never generates source, dependencies or scripts", async (t) => {
  const original = {
    private: true,
    type: "module",
    scripts: { build: "custom" },
    custom: { keep: true },
  };
  const cwd = await workspace(t, {
    "package.json": JSON.stringify(original),
    "automation/命令.md": commandFile("throw new Error('must not execute');"),
  });
  await mkdir(join(cwd, "specs"));
  const catalog = await readFile(join(cwd, "automation/命令.md"), "utf8");
  const result = JSON.parse(
    (await cli(cwd, "--init", "automation/命令.md", "specs/", "--json")).stdout,
  );
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.updated, [join(cwd, "package.json")]);
  const updated = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  assert.deepEqual(updated, {
    ...original,
    rundown: { commands: "./automation/命令.md", tests: "./specs" },
  });
  assert.equal(
    await readFile(join(cwd, "automation/命令.md"), "utf8"),
    catalog,
  );
  assert.deepEqual((await readdir(cwd)).sort(), [
    "automation",
    "package.json",
    "specs",
  ]);
  assert.deepEqual(await readdir(join(cwd, "specs")), []);
});

test("equivalent registrations are byte-preserving no-ops and omitted tests are untouched", async (t) => {
  const source =
    JSON.stringify(
      {
        private: true,
        rundown: {
          commands: "./automation/../automation/commands.md",
          tests: "./future-tests",
          theme: "keep",
        },
      },
      null,
      4,
    ) + "\n";
  const cwd = await workspace(t, {
    "package.json": source,
    "automation/commands.md": commandFile("return 1;"),
  });
  const original = NodeFilesystem.prototype.writeFileAtomicAsync;
  NodeFilesystem.prototype.writeFileAtomicAsync = async function () {
    throw new Error("No-op must not write");
  };
  try {
    const result = await initProject("automation/commands.md", { cwd });
    assert.deepEqual(result.updated, []);
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), source);
  } finally {
    NodeFilesystem.prototype.writeFileAtomicAsync = original;
  }
});

test("explicit paths reconfigure only selected entries and support single test files", async (t) => {
  const cwd = await workspace(t, {
    "package.json": JSON.stringify({
      private: true,
      rundown: { commands: "./old.md", tests: "./future-tests", theme: "keep" },
    }),
    "new.md": commandFile("return 2;"),
    "single.test.md": moduleFile("return;"),
  });
  await initProject("new.md", { cwd });
  let config = JSON.parse(
    await readFile(join(cwd, "package.json"), "utf8"),
  ).rundown;
  assert.deepEqual(config, {
    commands: "./new.md",
    tests: "./future-tests",
    theme: "keep",
  });
  await initProject(pathToFileURL(join(cwd, "new.md")), {
    cwd,
    tests: pathToFileURL(join(cwd, "single.test.md")),
  });
  config = JSON.parse(
    await readFile(join(cwd, "package.json"), "utf8"),
  ).rundown;
  assert.deepEqual(config, {
    commands: "./new.md",
    tests: "./single.test.md",
    theme: "keep",
  });
});

test("validation failures leave configuration untouched and do not create missing targets", async (t) => {
  const source = JSON.stringify({ private: true, custom: "keep" });
  const cwd = await workspace(t, {
    "package.json": source,
    "commands.md": commandFile("return 1;"),
    "module.md": moduleFile("return 1;"),
    "view.md.template": "# View\n",
    "invalid.md":
      "# Broken\n\n## Connections\n\n| File | Description |\n| --- | --- |\n| ./missing.md | Missing. |\n",
    "not-a-test.txt": "data",
  });
  for (const [catalog, tests] of [
    ["missing.md", undefined],
    ["module.md", undefined],
    ["view.md.template", undefined],
    ["invalid.md", undefined],
    ["commands.md", "not-a-test.txt"],
    ["commands.md", "missing-tests"],
  ]) {
    await assert.rejects(initProject(catalog, { cwd, tests }));
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), source);
  }
  await assert.rejects(access(join(cwd, "missing-tests")));
  for (const args of [
    ["--init", "commands.md", "extra", "too-many"],
    ["--commands", "commands.md", "--init", "commands.md"],
    ["--init", ""],
  ]) {
    await assert.rejects(cli(cwd, ...args));
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), source);
  }
});

test("registration requires an existing package and rejects malformed metadata", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "rundown-no-package-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "commands.md"), commandFile("return 1;"));
  await assert.rejects(initProject("commands.md", { cwd }), {
    code: "RUNDOWN_DISCOVERY",
  });
  await assert.rejects(access(join(cwd, "package.json")));
  for (const source of ["{", JSON.stringify({ rundown: null })]) {
    await writeFile(join(cwd, "package.json"), source);
    await assert.rejects(initProject("commands.md", { cwd }), {
      code: "RUNDOWN_PROJECT_CONFIG",
    });
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), source);
  }
});

test("registration updates a child package without inheriting or editing its parent", async (t) => {
  const parent = JSON.stringify({
    private: true,
    rundown: { commands: "./parent.md" },
  });
  const cwd = await workspace(t, {
    "package.json": parent,
    "automation/commands.md": commandFile("return 1;"),
    "child/package.json": JSON.stringify({ private: true }),
    "child/nested/keep": "",
  });
  await initProject("../../automation/commands.md", {
    cwd: join(cwd, "child/nested"),
  });
  assert.equal(await readFile(join(cwd, "package.json"), "utf8"), parent);
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, "child/package.json"), "utf8")).rundown,
    { commands: "../automation/commands.md" },
  );
});
