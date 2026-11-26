import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestRuntime } from "../sources/Testing.mjs";
import { Observability } from "../sources/Observability.mjs";
import {
  workspace,
  moduleFile,
  method,
  emptyParams,
  commandFile,
} from "./helpers.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
const run = (cwd, ...args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, "--cwd", cwd, "--test", ...args],
      {
        cwd: root,
        timeout: 20000,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
      (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
const params =
  emptyParams +
  "\n| t | object | yes | | Node context. |\n| context | object | yes | | Invocation. |";

test("shipped Markdown tests execute module/command behavior and callbacks", async () => {
  for (const example of ["greeting", "callbacks"]) {
    const result = await run(root + "/examples/" + example, "--json");
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.results.length, 2);
  }
});

test("Markdown tests isolate files and keep private methods and Examples non-executable", async (t) => {
  const body =
    moduleFile("globalThis.testMarker = true; console.log('user output');", {
      parameters: params,
    }) +
    "\n### Examples\n\n```js\nthrow new Error('documentation');\n```\n\n" +
    method("helper", "throw new Error('private');", {
      options:
        "### Options\n\n| Option | Value |\n| --- | --- |\n| Visibility | private |\n\n",
    });
  const cwd = await workspace(t, {
    "tests/a.test.md": body,
    "tests/nested/b.test.md": moduleFile(
      "if (globalThis.testMarker) throw new Error('not isolated'); if (process.cwd() !== context.workdir) throw new Error('cwd');",
      { parameters: params },
    ),
  });
  const result = await run(cwd, "--json");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results.length, 2);
  assert.match(result.stderr, /user output/);
  const human = await run(cwd, "tests/nested/b.test.md");
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /PASS/);
});

test("failed assertions retain original Markdown locations and fail the CLI", async (t) => {
  const cwd = await workspace(t, {
    "tests/fail.test.md": moduleFile(
      "const assert = await import('node:assert/strict'); assert.equal(1, 2, 'intentional failure');",
    ),
  });
  const result = await run(cwd, "--json");
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.results[0].error.message, /intentional failure/);
  assert.ok(
    report.results[0].error.locations.some(
      (location) =>
        location.source.endsWith("fail.test.md") &&
        location.precision === "exact",
    ),
    JSON.stringify(report),
  );
});

test("empty discovery, malformed documents and empty modules fail rather than pass", async (t) => {
  const cwd = await workspace(t, {
    "empty.test.md": "# Empty tests\n\nNo methods.\n",
    "bad.test.md": "not a module",
  });
  for (const args of [
    ["--json"],
    ["empty.test.md", "--json"],
    ["bad.test.md", "--json"],
  ]) {
    const result = await run(cwd, ...args);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout || result.stderr).ok, false);
    if (args[0] === "bad.test.md") {
      const report = JSON.parse(result.stdout);
      assert.ok(
        report.results[0].error.locations.some((location) =>
          location.source.endsWith("bad.test.md"),
        ),
      );
    }
  }
});

test("a dependency exiting successfully before registering tests cannot create a green result", async (t) => {
  const cwd = await workspace(t, {
    "exit.mjs": "process.exit(0);",
    "exit.test.md":
      "# Test\n\nA module.\n\n## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| ./exit.mjs | javascript | exit | Exits before registration. |\n\n" +
      method("run", "return 42;"),
  });
  const result = await run(cwd, "exit.test.md", "--json");
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /RUNDOWN_TEST_EMPTY/);
});

test("createTestRuntime uses real validation, injected capabilities and Node after-hook ownership", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": commandFile(`context.log.info('Observed');
    return context.adapters.worker.run({operation: 'inspect'});`),
  });
  let runtime;
  const records = [];
  await t.test("managed command", async (inner) => {
    runtime = await createTestRuntime(inner, {
      cwd,
      entry: "commands.md",
      observability: new Observability({
        sink: (record) => records.push(record),
      }),
      adapters: {
        worker: {
          async run(input) {
            return {
              cwd: input.cwd,
              operation: input.operation,
              cancelled: input.signal.aborted,
            };
          },
        },
      },
    });
    assert.deepEqual(await runtime.invoke("test"), {
      cwd,
      operation: "inspect",
      cancelled: false,
    });
    await assert.rejects(runtime.invoke("test", { unknown: 1 }), {
      code: "RUNDOWN_ARGUMENTS",
    });
  });
  assert.equal(records[0].message, "Observed");
  assert.ok(records[0].invocationId);
  await assert.rejects(runtime.invoke("test"), { code: "RUNDOWN_SHUTDOWN" });
});

test("test cleanup uses the selected grace period and revokes unfinished callbacks", async (t) => {
  const cwd = await workspace(t, {
    "cleanup.test.md": moduleFile(
      `const registration = context.callbacks.register({ stuck: {
    inputSchema: { type: 'object' }, handler: () => new Promise(() => {}),
  } }); registration.call('stuck', {}).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));`,
      { parameters: params },
    ),
  });
  const result = await run(
    cwd,
    "cleanup.test.md",
    "--grace-ms",
    "20",
    "--json",
  );
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /RUNDOWN_CLEANUP_TIMEOUT/);
});
