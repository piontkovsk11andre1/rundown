import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  loadModule,
  loadCommands,
  Runtime,
  compile,
  parseDocument,
} from "../sources/index.mjs";
import { workspace, moduleFile, method, commandFile } from "./helpers.mjs";
import { runProcess } from "../sources/Process.mjs";

const example = new URL("../examples/greeting/", import.meta.url);
test("manifest-backed greeting loads, dispatches, caches and hides helpers", async () => {
  const url = new URL("example/module.md", example);
  const module = await loadModule(url);
  assert.equal(await module.greet(), "Hello, World!");
  assert.equal(await module.greet("Ada"), "Hello, Ada!");
  assert.equal(await loadModule(url), module);
  assert.deepEqual(Object.keys(module), ["greet"]);
  const catalog = await loadCommands(undefined, {
    cwd: fileURLToPath(example),
  });
  const runtime = new Runtime(catalog);
  try {
    assert.equal(await runtime.invoke("example", {}), "Hello, World!");
    await assert.rejects(runtime.invoke("example", { name: 5 }), /string/);
  } finally {
    await runtime.close();
  }
});
test("native imports, circular live bindings and document identity", async (t) => {
  const dependencies = (file, binding) =>
    `## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| ${file} | markdown | ${binding} | Related module. |\n\n`;
  const dir = await workspace(t, {
    "a.md":
      "# A\n\n" +
      dependencies("./b.md", "b") +
      method("run", "return b.answer();") +
      method("value", "return import.meta.url;", {
        options:
          "### Options\n\n| Option | Value |\n| --- | --- |\n| Execution | sync |\n\n",
      }),
    "b.md":
      "# B\n\n" +
      dependencies("./a.md", "a") +
      method("answer", "return a.value();"),
    "native.md":
      "# Native\n\n## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| node:path | javascript | path | Paths. |\n\n" +
      method("run", "return path.basename(import.meta.url);"),
  });
  const a = await loadModule(join(dir, "a.md"));
  assert.equal(await a.run(), pathToFileURL(join(dir, "a.md")).href);
  assert.equal(
    await (await loadModule(join(dir, "native.md"))).run(),
    "native.md",
  );
  await writeFile(join(dir, "a.md"), moduleFile('return "changed";'));
  assert.equal(await loadModule(join(dir, "a.md")), a);
});
test("documentation code never enters the module; descriptions allow multiple paragraphs", () => {
  const source =
    moduleFile('return "ok";') +
    '\n### Examples\n\n```js\nthrow new Error("example must not execute");\n```\n\n## Background\n\nExplanatory prose.\n';
  const result = compile(source, "file:///test.md");
  assert.match(
    result.document.members[0].description,
    /Additional explanation/,
  );
  assert.doesNotMatch(result.code, /example must not execute/);
});
test("invalid signatures, bodies, options and tables fail", () => {
  const source = moduleFile('return "ok";');
  const invalid = [
    source.replace("### Returns", "### Result"),
    source.replace("```js", "```python"),
    source + "\n" + method("run", "return 1;"),
    source.replace(
      "### Parameters",
      "### Options\n\n| Option | Value |\n| --- | --- |\n| Execution | maybe |\n\n### Parameters",
    ),
    source.replace("| Type | Description |", "| Wrong | Description |"),
    moduleFile("return (;"),
    source.replace("### Implementation", "### Missing"),
  ];
  for (const value of invalid)
    assert.throws(() => compile(value, "file:///invalid.md"));
});
test("compile-only never loads dependencies or evaluates method examples", () => {
  const source =
    "# Compilation\n\n## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| ./missing.md | markdown | missing | Not read by compile-only. |\n\n" +
    method("run", "return missing.run();");
  assert.match(compile(source, "file:///compile.md").code, /missing.md/);
});
test("mapped runtime and syntax errors point to original Markdown, including CRLF", async (t) => {
  const source = moduleFile(
    'const word = "🦊";\nthrow new Error(word);',
  ).replaceAll("\n", "\r\n");
  const dir = await workspace(t, {
    "error.md": source,
    "commands.md": commandFile(
      'const m=await rundown.loadModule("./error.md"); return m.run();',
    ),
  });
  const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }));
  try {
    await assert.rejects(runtime.invoke("test"), (error) => {
      assert.equal(error.message, "🦊");
      assert.ok(error.cause instanceof Error);
      assert.ok(
        error.locations.some(
          (l) =>
            l.source.endsWith("/error.md") &&
            l.snippet.includes("throw new Error"),
        ),
      );
      return true;
    });
  } finally {
    await runtime.close();
  }
});
test("catalog connections deduplicate and reject cycles and duplicate commands", async (t) => {
  const connections = (files) =>
    "# Root\n\n## Connections\n\n| File | Description |\n| --- | --- |\n" +
    files.map((file) => `| ${file} | Imported commands. |`).join("\n") +
    "\n";
  const dir = await workspace(t, {
    "commands.md": connections(["./child.md", "./child.md"]),
    "child.md": commandFile("return 1;"),
  });
  assert.equal((await loadCommands(join(dir, "commands.md"))).commands.size, 1);
  await writeFile(
    join(dir, "cycle-root.md"),
    connections(["./cycle-child.md"]),
  );
  await writeFile(
    join(dir, "cycle-child.md"),
    connections(["./cycle-root.md"]),
  );
  await assert.rejects(loadCommands(join(dir, "cycle-root.md")), /cycle/);
  await writeFile(join(dir, "other.md"), commandFile("return 2;"));
  await writeFile(
    join(dir, "duplicates.md"),
    connections(["./child.md", "./other.md"]),
  );
  await assert.rejects(
    loadCommands(join(dir, "duplicates.md")),
    /Duplicate command/,
  );
});
test("definition rules reject invalid defaults, CLI positions and duplicate bindings", () => {
  const parameters =
    '| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |\n| value | string | yes | "bad" | 2 | Value. |';
  assert.throws(
    () =>
      parseDocument(
        commandFile("return args;", { parameters }),
        "file:///commands.md",
        "commands",
      ),
    /default/,
  );
  assert.throws(
    () =>
      parseDocument(
        commandFile("return args;", {
          parameters: parameters.replace('yes | "bad"', "yes | "),
        }),
        "file:///commands.md",
        "commands",
      ),
    /contiguous/,
  );
});
test("separate command and module templates ship their own grammar", async () => {
  for (const [name, body] of [
    ["module", "implementation"],
    ["commands", "handler"],
  ]) {
    const source = await readFile(
      new URL(`../templates/${name}.md.template`, import.meta.url),
      "utf8",
    );
    assert.match(source, new RegExp(`\\.as\\("${body}"\\)`));
    assert.match(source, /doc\.scope\(/);
    assert.match(source, /doc\.optional\(/);
    assert.doesNotMatch(
      source,
      /doc\.context|options\.kind|snapshotCursor|restoreCursor|rawBlock\(/,
    );
  }
});

test("diagnostics map correctly with Node native source maps enabled or disabled", async (t) => {
  const source = moduleFile('throw new Error("mapped failure");');
  const expected =
    source.split("\n").findIndex((line) => line.includes("throw new Error")) +
    1;
  const dir = await workspace(t, {
    "fault.md": source,
    "commands.md": commandFile(
      'const m=await rundown.loadModule("./fault.md");return m.run();',
    ),
  });
  const api = new URL("../sources/index.mjs", import.meta.url).href;
  const script = `import {loadCommands,Runtime,diagnostic} from ${JSON.stringify(api)}; const runtime=new Runtime(await loadCommands(undefined,{cwd:${JSON.stringify(dir)}}));try {await runtime.invoke("test");} catch(error) {console.log(JSON.stringify({...diagnostic(error),nativeStack:error.cause?.stack,enabled:process.sourceMapsEnabled}));} finally {await runtime.close();}`;
  for (const flags of [[], ["--enable-source-maps"]]) {
    const result = await runProcess(process.execPath, [
      ...flags,
      "--input-type=module",
      "-e",
      script,
    ]);
    const error = JSON.parse(result.stdout);
    assert.ok(
      error.locations.some(
        (location) =>
          location.source.endsWith("/fault.md") &&
          location.range.start.line === expected,
      ),
      result.stdout,
    );
  }
});

test("recognized sections cannot silently become prose when their table is missing", () => {
  for (const section of ["Dependencies", "Constants"]) {
    assert.throws(
      () =>
        compile(
          "# Module\n\n## " +
            section +
            "\n\nNot a definition table.\n\n" +
            method("run", "return 1;"),
          "file:///bad.md",
        ),
      /definition table/,
    );
  }
  const source = moduleFile("return 1;").replace(
    "### Parameters",
    "### Parameters\n\n### Parameters",
  );
  assert.throws(
    () => compile(source, "file:///bad.md"),
    (error) => {
      assert.match(error.message, /definition table/);
      assert.ok(
        error.locations.some(
          (location) =>
            location.source === "file:///bad.md" &&
            location.range.start.line > 1,
        ),
      );
      return true;
    },
  );
});

test("additional command JSON Schema constrains nested values and defaults remain detached", async (t) => {
  const parameters =
    '| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |\n| config | object | yes | | --config | Configuration. |\n| target | path | no | "Target.md" | --target | Target path. |';
  const extra =
    '### Schema\n\n```json\n{"type":"object","properties":{"config":{"type":"object","properties":{"mode":{"enum":["fast","safe"]}},"required":["mode"],"additionalProperties":false}}}\n```\n\n';
  const dir = await workspace(t, {
    "commands.md": commandFile("return args;", { parameters, extra }),
  });
  const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }), {
    cwd: dir,
  });
  try {
    const input = { config: { mode: "fast" } };
    const result = await runtime.invoke("test", input);
    assert.equal(result.target, join(dir, "Target.md"));
    assert.deepEqual(input, { config: { mode: "fast" } });
    await assert.rejects(
      runtime.invoke("test", { config: { mode: "wrong" } }),
      /allowed values/,
    );
    await assert.rejects(
      runtime.invoke("test", { config: { mode: "safe", extra: true } }),
      /additional properties/,
    );
  } finally {
    await runtime.close();
  }
});

test("composed templates preserve documentation and ignore nested/fenced structural lookalikes", () => {
  const prose =
    "A documented method.\n\n- A list item.\n  - ### Parameters\n\n> ## Method: quoted\n> ### Implementation\n> Documentation only.\n\n```md\n## Method: fenced\n### Parameters\n```\n\n### Background\n\n| Detail | Value |\n| --- | --- |\n| Context | Documentation table. |\n";
  const options =
    "### Options\n\nExecution policy.\n\n| Option | Value |\n| --- | --- |\n| Execution | sync |\n\n### Explanation\n\nThese options apply to this method.\n\n";
  let source = moduleFile('return "real body";', {
    description: prose,
    options,
  });
  source = source.replace(
    "### Parameters\n\n| Name",
    "### **Parameters**\n\n| Name",
  );
  source = source.replace(
    "### Returns",
    "### Returns\n\nThe result is described below.",
  );
  source +=
    '\n### Examples\n\n```js\nthrow new Error("not executed");\n```\n\n#### Example details\n\n| Detail | Value |\n| --- | --- |\n| Purpose | Documentation only. |\n\n' +
    method("second", 'return "second body";');
  const result = compile(source, "file:///documentation.md");
  assert.deepEqual(
    result.document.members.map((member) => member.name),
    ["run", "second"],
  );
  assert.equal(result.document.members[0].options.Execution, "sync");
  assert.match(result.document.members[0].description, /Documentation table/);
  assert.doesNotMatch(result.code, /not executed/);
  assert.equal(
    result.document.members[0].body.position.start.line,
    source.split("\n").findIndex((line) => line === "```js") + 1,
  );
});

test("required field composition rejects reordering and duplicate structural blocks", () => {
  const source = moduleFile('return "value";');
  for (const value of [
    source
      .replace("### Parameters", "### Returns")
      .replace("### Returns\n\n| Type", "### Parameters\n\n| Type"),
    source.replace(
      "### Returns",
      "| Extra | Table |\n| --- | --- |\n\n### Returns",
    ),
    source + '\n```js\nthrow new Error("second implementation");\n```\n',
  ])
    assert.throws(() => compile(value, "file:///invalid-structure.md"));
});

test("native slot positions retain schema, table and body identity", () => {
  const parameters =
    "| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |\n| value | integer | yes | | 1 | A value. |";
  const extra =
    '### Schema\n\n```json\n{"type":"object","properties":{"value":{"minimum":1}}}\n```\n\n';
  const source = commandFile("return args.value;", {
    parameters,
    extra,
  }).replaceAll("\n", "\r\n");
  const document = parseDocument(source, "file:///bindings.md", "commands");
  const member = document.members[0];
  assert.equal(member.sections.schema.properties.value.minimum, 1);
  assert.equal(
    source
      .slice(
        member.sections.Parameters.position.start.offset,
        member.sections.Parameters.position.end.offset,
      )
      .trim()
      .startsWith("| Name | Type"),
    true,
  );
  assert.match(
    source.slice(
      member.body.position.start.offset,
      member.body.position.end.offset,
    ),
    /^```js\r\nreturn args.value;/,
  );
});
