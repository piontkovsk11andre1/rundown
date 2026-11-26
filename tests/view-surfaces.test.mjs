import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Runtime, loadCommands } from "../sources/index.mjs";
import { startHttp } from "../sources/Http.mjs";
import { createMcpServer } from "../sources/Mcp.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runProcess } from "../sources/Process.mjs";
import { checkProject } from "../sources/Authoring.mjs";
import { spawn } from "node:child_process";
import { workspace, commandFile } from "./helpers.mjs";
import { View } from "../sources/Views.mjs";

const cwd = fileURLToPath(new URL("../examples/views/", import.meta.url));
const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
const expected = {
  status: "Completed",
  completed: 3,
  total: 3,
  findings: ["All items processed."],
};

test("view example checks and CLI renders final Markdown or final JSON", async () => {
  assert.equal((await checkProject({ cwd })).ok, true);
  for (const flags of [[], ["--markdown"], ["--json"]]) {
    const result = await runProcess(
      process.execPath,
      [bin, "--cwd", cwd, ...flags, "report"],
      { cwd },
    );
    if (flags.includes("--json"))
      assert.deepEqual(JSON.parse(result.stdout), expected);
    else {
      assert.match(result.stdout, /# Processing report/);
      assert.match(result.stdout, /Processed \*\*3\*\*/);
    }
    assert.match(result.stderr, /Processed item/);
    assert.ok(!result.stdout.includes("\x1b"));
  }
});

test("HTTP waits for closure and exposes final state or requested Markdown dimensions", async (t) => {
  const runtime = new Runtime(await loadCommands(undefined, { cwd }), { cwd });
  const http = await startHttp({ runtime });
  t.after(() => http.close());
  const response = await fetch(http.url + "/commands/report", {
    method: "POST",
    body: "{}",
  });
  assert.deepEqual((await response.json()).result, expected);
  const markdown = await fetch(
    http.url + "/commands/report?width=45&height=20",
    { method: "POST", body: "{}", headers: { accept: "text/markdown" } },
  );
  assert.match(markdown.headers.get("content-type"), /text\/markdown/);
  assert.match(await markdown.text(), /Display width: 45/);
  const invalid = await fetch(http.url + "/commands/report?width=-1", {
    method: "POST",
    body: "{}",
    headers: { accept: "text/markdown" },
  });
  assert.equal(invalid.status, 400);
});

test("MCP returns final Markdown content alongside structured JSON state", async (t) => {
  const runtime = new Runtime(await loadCommands(undefined, { cwd }), { cwd });
  const server = createMcpServer({ runtime });
  const client = new Client({ name: "view-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await runtime.close();
  });
  const result = await client.callTool({ name: "report", arguments: {} });
  assert.deepEqual(result.structuredContent.result, expected);
  assert.match(result.content[0].text, /# Processing report/);
});

test(
  "an open view keeps the CLI alive after successful attached work until cancellation",
  { timeout: 10000 },
  async (t) => {
    const directory = await workspace(t, {
      "commands.md":
        commandFile(`const {View} = await import('@p10i/rundown/views');
    const view = new View('# Waiting', {});
    view.track(Promise.resolve());
    console.log('Ready');
    return view;`),
    });
    const child = spawn(process.execPath, [bin, "--cwd", directory, "test"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill());
    const closed = new Promise((resolve) => child.once("close", resolve));
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("Ready")) resolve();
      });
      child.once("error", reject);
      child.once("close", (code) =>
        reject(new Error(`Exited before mounting: ${code}`)),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null);
    child.kill("SIGTERM");
    await closed;
  },
);

test("disconnecting an HTTP view request cancels its live invocation and tracked work", async (t) => {
  let view, ready, aborted;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const cancelled = new Promise((resolve) => {
    aborted = resolve;
  });
  const command = {
    name: "test",
    parameters: [],
    surfaces: ["*"],
    validate() {},
    handler(_args, context) {
      view = new View("# Waiting", {});
      view.track(
        new Promise((resolve) =>
          context.signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true },
          ),
        ),
      );
      ready();
      return view;
    },
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { graceMs: 100 },
  );
  const http = await startHttp({ runtime });
  t.after(() => http.close());
  const controller = new AbortController();
  const response = fetch(http.url + "/commands/test", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  response.catch(() => {});
  await started;
  controller.abort();
  await assert.rejects(response);
  await cancelled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.state, "cancelled");
});
