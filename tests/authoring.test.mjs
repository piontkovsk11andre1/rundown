import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Reader } from "@p10i/do-md";
import {
  initProject,
  newCommand,
  newModule,
  checkProject,
  readSkill,
  renderReference,
  reference,
} from "../sources/Authoring.mjs";
import { loadCommands, Runtime } from "../sources/index.mjs";
import { startHttp } from "../sources/Http.mjs";
import { COLUMNS } from "../sources/Format.mjs";
import { runProcess } from "../sources/Process.mjs";
import {
  workspace,
  moduleFile,
  commandFile,
  copyGreeting,
} from "./helpers.mjs";

const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
const cli = (cwd, ...args) =>
  runProcess(process.execPath, [bin, "--cwd", cwd, ...args], {
    cwd,
    timeoutMs: 10000,
  });

test("existing-source onboarding registers paths, creates connected commands and checks without executing", async (t) => {
  const cwd = await workspace(t);
  const initial = await cli(cwd);
  assert.match(initial.stdout, /--init/);
  assert.match(initial.stdout, /No project catalog/);
  await copyGreeting(cwd);
  const init = await cli(cwd, "--init", "commands.md", "tests", "--json");
  assert.equal(JSON.parse(init.stdout).created.length, 0);
  assert.equal(JSON.parse(init.stdout).updated.length, 1);
  assert.equal((await cli(cwd, "example", "Ada")).stdout, "Hello, Ada!\n");
  const generated = JSON.parse(
    (await cli(cwd, "--new-command", "hello", "--json")).stdout,
  );
  assert.equal(generated.created.length, 2);
  assert.equal(generated.updated.length, 1);
  assert.equal((await cli(cwd, "hello")).stdout, "hello is ready.\n");
  assert.equal(
    (await cli(cwd, "hello", "Custom message")).stdout,
    "Custom message\n",
  );
  await cli(cwd, "--new-module", "hello/helper.md");
  const checked = JSON.parse((await cli(cwd, "--check", "--json")).stdout);
  assert.equal(checked.ok, true);
  assert.equal(checked.commands.length, 2);
  assert.equal(checked.files.length, 5);
  assert.equal(
    JSON.parse((await cli(cwd, "--check", "hello/helper.md", "--json")).stdout)
      .ok,
    true,
  );
});

test("generators refuse conflicts without overwriting unrelated or existing files", async (t) => {
  const cwd = await workspace(t, { "Notes.md": "Keep me.\n" });
  await copyGreeting(cwd);
  await initProject("commands.md", { cwd, tests: "tests" });
  const root = join(cwd, "commands.md");
  const original = await readFile(root, "utf8");
  assert.deepEqual((await initProject("commands.md", { cwd })).updated, []);
  await assert.rejects(newCommand("example", { cwd }), /already defined/);
  await assert.rejects(
    newModule("example/module.md", { cwd }),
    (error) => error.code === "RUNDOWN_AUTHORING_CONFLICT",
  );
  await mkdir(join(cwd, "conflict"));
  await writeFile(join(cwd, "conflict/module.md"), "User module.\n");
  await assert.rejects(
    newCommand("conflict", { cwd }),
    (error) => error.code === "RUNDOWN_AUTHORING_CONFLICT",
  );
  await assert.rejects(access(join(cwd, "conflict/commands.md")));
  assert.equal(await readFile(root, "utf8"), original);
  assert.equal(await readFile(join(cwd, "Notes.md"), "utf8"), "Keep me.\n");
});

test("Connections editing preserves surrounding CRLF documentation and handles a missing table section", async (t) => {
  const cwd = await workspace(t);
  await copyGreeting(cwd);
  await initProject("commands.md", { cwd, tests: "tests" });
  const root = join(cwd, "commands.md");
  const original =
    (await readFile(root, "utf8")).replace(
      "## Connections",
      "A  paragraph with extra spaces.\n\n## Connections",
    ) + "\n## Notes\n\nKeep this tail exactly.\n";
  await writeFile(root, original.replaceAll("\n", "\r\n"));
  await newCommand("second", { cwd });
  const changed = await readFile(root, "utf8");
  assert.ok(
    changed.startsWith(
      "# Project commands\r\n\r\nCommands for producing friendly greetings.\r\n\r\nA  paragraph",
    ),
  );
  assert.ok(
    changed.endsWith("\r\n## Notes\r\n\r\nKeep this tail exactly.\r\n"),
  );
  const other = await workspace(t, {
    "commands.md": commandFile('return "local";'),
  });
  await newCommand("extra", { cwd: other });
  assert.equal((await checkProject({ cwd: other })).ok, true);
  assert.ok(
    (await readFile(join(other, "commands.md"), "utf8")).includes(
      'return "local";',
    ),
  );
});

test("concurrent distinct command scaffolds merge Connections with revision checks", async (t) => {
  const cwd = await workspace(t);
  await copyGreeting(cwd);
  await initProject("commands.md", { cwd, tests: "tests" });
  await Promise.all([newCommand("one", { cwd }), newCommand("two", { cwd })]);
  const checked = await checkProject({ cwd });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.commands.map((c) => c.name).sort(), [
    "example",
    "one",
    "two",
  ]);
});

test("check follows static graphs but never evaluates user JavaScript or handlers", async (t) => {
  const cwd = await workspace(t, {
    "package.json": JSON.stringify({
      private: true,
      rundown: { commands: "./commands.md" },
    }),
  });
  const marker = join(cwd, "executed.txt");
  await writeFile(
    join(cwd, "commands.md"),
    commandFile(
      'const m=await rundown.loadModule("./module.md");return m.run();',
    ),
  );
  await writeFile(
    join(cwd, "evil.mjs"),
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"executed");export const value=1;`,
  );
  await writeFile(
    join(cwd, "module.md"),
    "# Module\n\n## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| ./evil.mjs | javascript | evil | Must not evaluate. |\n\n" +
      moduleFile('throw new Error("must not run");')
        .split("\n")
        .slice(4)
        .join("\n"),
  );
  const checked = await checkProject({ cwd });
  assert.equal(checked.ok, true);
  assert.equal(checked.files.length, 2);
  assert.equal(checked.dependencies.length, 1);
  await assert.rejects(access(marker));
});

test("check reports missing files, schema errors and dynamic/shadowed loads accurately", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": commandFile('return rundown.loadModule("./missing.md");'),
  });
  const missing = await checkProject({ cwd });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.errors[0].locations.some(
      (location) =>
        location.source.endsWith("/commands.md") &&
        location.range.start.line > 1,
    ),
  );
  await writeFile(
    join(cwd, "commands.md"),
    commandFile("return rundown.loadModule(args.file);"),
  );
  const dynamic = await checkProject({ cwd });
  assert.equal(dynamic.ok, true);
  assert.equal(dynamic.dynamicLoads.length, 1);
  await writeFile(
    join(cwd, "commands.md"),
    commandFile(
      'const {rundown}=context.adapters; return rundown.loadModule("./not-a-real-reference.md");',
    ),
  );
  const shadowed = await checkProject({ cwd });
  assert.equal(shadowed.ok, true);
  assert.equal(shadowed.dynamicLoads.length, 1);
  await writeFile(
    join(cwd, "commands.md"),
    commandFile("return args;", {
      parameters:
        '| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |\n| value | integer | no | "wrong" | 1 | A value. |',
    }),
  );
  const invalid = await checkProject({ cwd });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors[0].message, /default/);
});

test("Skill and reference are shared between CLI, generated definitions and MCP resources", async (t) => {
  const cwd = await workspace(t);
  await copyGreeting(cwd);
  await initProject("commands.md", { cwd, tests: "tests" });
  const skill = await readSkill();
  assert.equal((await cli(cwd, "--skill")).stdout, skill);
  assert.equal(JSON.parse((await cli(cwd, "--skill", "--json")).stdout), skill);
  assert.equal(new Reader(skill).frontmatter().value.data.name, "rundown");
  assert.deepEqual(
    JSON.parse(
      (await cli(cwd, "--reference", "modules", "--format", "json")).stdout,
    ),
    reference("modules"),
  );
  assert.deepEqual(
    reference("commands").columns.parameters,
    COLUMNS.commandParameters,
  );
  const runtime = new Runtime(await loadCommands(undefined, { cwd }), { cwd });
  const http = await startHttp({ runtime });
  const client = new Client({ name: "authoring-resource-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(http.url + "/mcp")),
    );
    const resources = (await client.listResources()).resources;
    assert.ok(
      resources.some((resource) => resource.uri === "rundown://skills/rundown"),
    );
    assert.equal(
      (await client.readResource({ uri: "rundown://skills/rundown" }))
        .contents[0].text,
      skill,
    );
    assert.equal(
      (await client.readResource({ uri: "rundown://reference/modules" }))
        .contents[0].text,
      renderReference("modules"),
    );
    for (const args of [
      ["--cwd", cwd, "--mcp"],
      ["--mcp-http", http.url + "/mcp"],
    ]) {
      const stdio = new Client({
        name: "authoring-stdio-resources",
        version: "1",
      });
      await stdio.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [bin, ...args],
          stderr: "pipe",
        }),
      );
      try {
        assert.ok(
          (await stdio.listResources()).resources.some(
            (resource) => resource.uri === "rundown://skills/rundown",
          ),
        );
        assert.equal(
          (await stdio.readResource({ uri: "rundown://skills/rundown" }))
            .contents[0].text,
          skill,
        );
      } finally {
        await stdio.close();
      }
    }
  } finally {
    await client.close();
    await http.close();
  }
});

test("built-ins work without discovery and do not silently interpret init presets", async (t) => {
  const cwd = await workspace(t);
  assert.match(
    (await cli(cwd, "--reference", "callbacks")).stdout,
    /Callbacks/,
  );
  for (const args of [
    ["--init", "todo"],
    ["--init", "--mcp"],
    ["--new-command", "--cwd", cwd],
    ["--reference", "unknown"],
  ])
    await assert.rejects(cli(cwd, ...args));
  const before = await checkProject({ cwd });
  await assert.rejects(cli(cwd, "--json", "--unknown"), (error) => {
    assert.match(error.message, /"code":"RUNDOWN_CLI"/);
    return true;
  });
  assert.equal(before.ok, false);
  await newModule("module.md", { cwd });
  assert.equal((await checkProject({ cwd, file: "module.md" })).ok, true);
});

test("checks distinguish independent literal catalogs and reject connection cycles", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": commandFile('return rundown.loadCommands("./private.md");'),
    "private.md": commandFile("return 1;", { name: "isolated" }),
  });
  const checked = await checkProject({ cwd });
  assert.equal(checked.ok, true);
  assert.deepEqual(
    checked.commands.map((command) => command.name),
    ["test"],
  );
  await newCommand("isolated", { cwd });
  assert.equal((await checkProject({ cwd })).ok, true);
  await writeFile(
    join(cwd, "commands.md"),
    "# Root\n\n## Connections\n\n| File | Description |\n| --- | --- |\n| ./commands.md | A cycle. |\n",
  );
  const cycle = await checkProject({ cwd });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.errors[0].code, "RUNDOWN_CONNECTION_CYCLE");
});

test("human authoring errors expose the underlying actionable check diagnostics", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": commandFile("return 1;").replace(
      "### Returns",
      "### Results",
    ),
  });
  await assert.rejects(cli(cwd, "--new-command", "extra"), (error) => {
    assert.match(error.message, /Fix the catalog/);
    assert.match(error.message, /Related:/);
    assert.match(error.message, /Expected heading: Returns/);
    assert.match(error.message, /commands.md/);
    return true;
  });
});
