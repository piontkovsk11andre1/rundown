import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  loadModule,
  loadCommands,
  compileFile,
  Runtime,
  diagnostic,
  RundownError,
} from "../sources/index.mjs";
import { workspace, commandFile, moduleFile } from "./helpers.mjs";
import { startHttp } from "../sources/Http.mjs";

test("missing entries normalize filesystem causes for loaders and compile-only", async (t) => {
  const dir = await workspace(t);
  const url = pathToFileURL(join(dir, "missing.md"));
  const check = (error) => {
    assert.equal(error.code, "RUNDOWN_RESOLUTION");
    assert.equal(error.status, 404);
    assert.equal(error.cause.code, "ENOENT");
    assert.equal(error.locations[0].source, url.href);
    assert.equal(error.locations[0].precision, "context");
    assert.equal(error.locations[0].snippet, null);
    return true;
  };
  await assert.rejects(loadModule(url), check);
  await assert.rejects(loadCommands(url), check);
  assert.throws(() => compileFile(url), check);
});
test("connection failures preserve parent document processing locations", async (t) => {
  const dir = await workspace(t, {
    "commands.md":
      "# Root\n\n## Connections\n\n| File | Description |\n| --- | --- |\n| ./missing.md | Missing child. |\n",
  });
  await assert.rejects(loadCommands(join(dir, "commands.md")), (error) => {
    assert.equal(error.code, "RUNDOWN_RESOLUTION");
    assert.equal(error.cause.code, "ENOENT");
    assert.ok(
      error.locations.some(
        (l) =>
          l.source.endsWith("/commands.md") &&
          l.relation === "processing" &&
          l.snippet.includes("File"),
      ),
    );
    return true;
  });
});
test("module resolution failures include the calling Markdown document", async (t) => {
  const dir = await workspace(t, {
    "caller.md": moduleFile('return rundown.loadModule("./missing.md");'),
  });
  const module = await loadModule(join(dir, "caller.md"));
  await assert.rejects(module.run(), (error) => {
    assert.equal(error.code, "RUNDOWN_RESOLUTION");
    assert.ok(
      error.locations.some(
        (l) =>
          l.source.endsWith("/caller.md") &&
          l.relation === "processing" &&
          l.snippet === "# Test module",
      ),
    );
    return true;
  });
});
test("native dependency failures retain cause and source context", async (t) => {
  const source =
    "# Dependency\n\n## Dependencies\n\n| Source | Kind | Binding | Description |\n| --- | --- | --- | --- |\n| ./missing.mjs | javascript | missing | Missing dependency. |\n\n" +
    moduleFile("return missing;").split("\n").slice(4).join("\n");
  const dir = await workspace(t, { "dependency.md": source });
  await assert.rejects(loadModule(join(dir, "dependency.md")), (error) => {
    assert.equal(error.code, "RUNDOWN_RESOLUTION");
    assert.equal(error.cause.code, "ERR_MODULE_NOT_FOUND");
    assert.ok(
      error.locations.some(
        (l) =>
          l.source.endsWith("dependency.md") && l.relation === "processing",
      ),
    );
    return true;
  });
});
test("frozen exceptions and arbitrary cancellation reasons retain consistent diagnostics", async () => {
  for (const cause of [
    Object.freeze(new Error("native")),
    Object.freeze(new RundownError("CUSTOM", "domain")),
  ]) {
    const command = {
      name: "test",
      parameters: [],
      surfaces: ["*"],
      validate: () => {},
      handler: () => {
        throw cause;
      },
    };
    const runtime = new Runtime({ commands: new Map([["test", command]]) });
    try {
      await assert.rejects(runtime.invoke("test"), (error) => {
        assert.equal(error.cause, cause);
        assert.ok(diagnostic(error).invocationId);
        return true;
      });
    } finally {
      await runtime.close();
    }
  }
  const controller = new AbortController();
  controller.abort(0);
  const command = {
    name: "test",
    parameters: [],
    surfaces: ["*"],
    validate: () => {},
    handler: () => 1,
  };
  const runtime = new Runtime({ commands: new Map([["test", command]]) });
  try {
    await assert.rejects(
      runtime.invoke("test", {}, { signal: controller.signal }),
      (error) => error.code === "RUNDOWN_CANCELLED" && error.cause === 0,
    );
  } finally {
    await runtime.close();
  }
});
test("HTTP envelopes retain source diagnostics and reject malformed URL encoding", async (t) => {
  const dir = await workspace(t, {
    "commands.md": commandFile('return rundown.loadModule("./missing.md");'),
  });
  const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }));
  const http = await startHttp({ runtime });
  try {
    const response = await fetch(http.url + "/commands/test", {
      method: "POST",
      body: "{}",
    });
    const result = await response.json();
    assert.equal(response.status, 404);
    assert.equal(result.error.code, "RUNDOWN_RESOLUTION");
    assert.ok(result.error.invocationId);
    assert.ok(
      result.error.locations.some((l) => l.source.endsWith("/commands.md")),
    );
    assert.equal((await fetch(http.url + "/commands/%ZZ")).status, 400);
  } finally {
    await http.close();
  }
});
