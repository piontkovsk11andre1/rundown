import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadCommands, Runtime } from "../sources/index.mjs";
import { startHttp } from "../sources/Http.mjs";
import { Observability } from "../sources/Observability.mjs";
import { workspace, commandFile, moduleFile } from "./helpers.mjs";

const cwd = fileURLToPath(new URL("../examples/greeting/", import.meta.url));
const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
async function client(url) {
  const value = new Client({ name: "test", version: "1" });
  await value.connect(new StreamableHTTPClientTransport(new URL(url)));
  return value;
}
async function fixture(t) {
  const runtime = new Runtime(await loadCommands(undefined, { cwd }), { cwd });
  const http = await startHttp({ runtime });
  t.after(() => http.close());
  return { runtime, http };
}

test("HTTP discovery, execution, defaults and malformed arguments", async (t) => {
  const { http } = await fixture(t);
  const list = await (await fetch(http.url + "/commands")).json();
  assert.equal(list.result[0].name, "example");
  assert.equal(
    (await (await fetch(http.url + "/commands/example")).json()).result
      .inputSchema.type,
    "object",
  );
  for (const [input, result] of [
    [{}, "Hello, World!"],
    [{ name: "Ada" }, "Hello, Ada!"],
  ]) {
    const response = await fetch(http.url + "/commands/example", {
      method: "POST",
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result });
  }
  for (const input of ['{"name":5}', "not JSON", '{"extra":true}']) {
    const response = await fetch(http.url + "/commands/example", {
      method: "POST",
      body: input,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  }
});
test("Streamable HTTP advertises each command as a tool and returns protocol errors", async (t) => {
  const { http } = await fixture(t);
  const c = await client(http.url + "/mcp");
  t.after(() => c.close());
  assert.deepEqual(
    (await c.listTools()).tools.map((tool) => tool.name),
    ["example"],
  );
  const result = await c.callTool({
    name: "example",
    arguments: { name: "Ada" },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.result, "Hello, Ada!");
  assert.equal(
    (await c.callTool({ name: "example", arguments: { name: 9 } })).isError,
    true,
  );
});
test("CLI aliases, help and argument conversion", async () => {
  async function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, "--cwd", cwd, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output, errors }));
    });
  }
  assert.deepEqual(await run(["example", "Ada"]), {
    code: 0,
    output: "Hello, Ada!\n",
    errors: "",
  });
  assert.equal((await run(["example"])).output, "Hello, World!\n");
  assert.equal((await run(["example", "Ada", "extra"])).code, 1);
  assert.match(
    (await run(["help", "example"])).output,
    /name: string.*default "World"/,
  );
  assert.equal((await run(["--mcp", "--serve"])).code, 1);
});
test("stdio MCP and remote bridge preserve tool discovery and execution", async (t) => {
  const { http } = await fixture(t);
  for (const args of [
    ["--cwd", cwd, "--mcp"],
    ["--mcp-http", http.url + "/mcp"],
  ]) {
    const c = new Client({ name: "stdio-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, ...args],
      stderr: "pipe",
    });
    await c.connect(transport);
    try {
      assert.equal((await c.listTools()).tools[0].name, "example");
      assert.equal(
        (await c.callTool({ name: "example", arguments: {} })).structuredContent
          .result,
        "Hello, World!",
      );
    } finally {
      await c.close();
    }
  }
});
test("scoped callbacks expose only their own tools through HTTP and MCP", async (t) => {
  const records = [];
  let reached;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const dir = await workspace(t, {
    "commands.md": commandFile(
      'const registration = await context.callbacks.register({update: {inputSchema: {type:"object",properties:{value:{type:"integer"}},required:["value"],additionalProperties:false},handler:({value})=>value+1}}, {reporting:{logs:true}}); context.adapters.ready(registration); await context.adapters.hold; return "done";',
    ),
  });
  const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }), {
    cwd: dir,
    observability: new Observability({ sink: (r) => records.push(r) }),
    adapters: { ready: reached, hold },
  });
  const invocation = runtime.invoke("test");
  const reg = await ready;
  assert.equal(runtime.callbackHost.server, undefined);
  const exposure = await reg.expose();
  const c = await client(exposure.mcp.url);
  try {
    assert.deepEqual(
      (await c.listTools()).tools.map((t) => t.name),
      ["update", "report_log"],
    );
    const result = await c.callTool({
      name: "update",
      arguments: { value: 4 },
    });
    assert.equal(result.structuredContent.result, 5);
    const response = await fetch(exposure.url + "/update", {
      method: "POST",
      body: '{"value":9}',
    });
    assert.equal((await response.json()).result, 10);
    await c.callTool({
      name: "report_log",
      arguments: { level: "info", message: "External progress" },
    });
    assert.equal(records[0].message, "External progress");
    await assert.rejects(c.callTool({ name: "example", arguments: {} }));
  } finally {
    await c.close();
    release();
    await invocation;
    await runtime.close();
  }
  assert.equal(reg.state, "closed");
  assert.equal(runtime.callbackHost.registrations.size, 0);
});
test("surface restrictions filter discovery and reject direct invocation", async (t) => {
  const dir = await workspace(t, {
    "commands.md": commandFile('return "only CLI";', {
      options:
        "### Options\n\n| Option | Value |\n| --- | --- |\n| Surfaces | cli |\n\n",
    }),
  });
  const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }));
  const http = await startHttp({ runtime });
  t.after(() => http.close());
  assert.deepEqual(
    (await (await fetch(http.url + "/commands")).json()).result,
    [],
  );
  assert.equal(
    (await fetch(http.url + "/commands/test", { method: "POST", body: "{}" }))
      .status,
    403,
  );
  const c = await client(http.url + "/mcp");
  try {
    assert.deepEqual((await c.listTools()).tools, []);
  } finally {
    await c.close();
  }
});
test("compile-only emits maps without evaluating missing dependencies", async (t) => {
  const dir = await workspace(t, {
    "module.md": moduleFile('throw new Error("must not execute");'),
  });
  const child = spawn(
    process.execPath,
    [bin, "--compile", dir + "/module.md", "--out", dir + "/output"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, errors);
  const { readdir, readFile } = await import("node:fs/promises");
  const files = await readdir(dir + "/output");
  assert.equal(files.length, 2);
  const map = JSON.parse(
    await readFile(
      dir + "/output/" + files.find((f) => f.endsWith(".map")),
      "utf8",
    ),
  );
  assert.equal(map.sourcesContent.length, 1);
});

test("disconnecting an HTTP request aborts its invocation and closes callbacks", async (t) => {
  let ready;
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  const dir = await workspace(t, {
    "commands.md": commandFile(
      'const registration=context.callbacks.register({done:{inputSchema:{type:"object"},handler:()=>1}});context.adapters.ready({registration,signal:context.signal});await new Promise(resolve=>context.signal.addEventListener("abort",resolve,{once:true}));return "stopped";',
    ),
  });
  const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }), {
    adapters: { ready },
  });
  const http = await startHttp({ runtime });
  t.after(() => http.close());
  const controller = new AbortController();
  const response = fetch(http.url + "/commands/test", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  const rejected = assert.rejects(response);
  const state = await entered;
  controller.abort();
  await rejected;
  for (let i = 0; i < 100 && !state.signal.aborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(state.signal.aborted, true);
  await runtime.close();
  assert.equal(runtime.callbackHost.registrations.size, 0);
});

test(
  "CLI interrupt enforces its grace deadline for lingering JavaScript handles",
  {
    timeout: 5000,
    skip:
      process.platform === "win32"
        ? "child.kill does not deliver console Ctrl+C on Windows; AbortSignal cancellation is tested separately"
        : false,
  },
  async (t) => {
    const dir = await workspace(t, {
      "commands.md": commandFile(
        'setInterval(()=>{},1000);process.stdout.write("READY\\n");await new Promise(()=>{});',
      ),
    });
    const child = spawn(
      process.execPath,
      [bin, "--cwd", dir, "--grace-ms", "30", "test"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    child.stderr.resume();
    let sent = false;
    child.stdout.on("data", () => {
      if (!sent) {
        sent = true;
        child.kill("SIGINT");
      }
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
  },
);

test(
  "MCP cancellation reaches only the requesting session's invocation",
  { timeout: 5000 },
  async (t) => {
    const seen = new Map();
    let ready;
    const entered = new Promise((resolve) => {
      ready = resolve;
    });
    const dir = await workspace(t, {
      "commands.md": commandFile(
        'context.adapters.observe(args.label,context);await new Promise(resolve=>context.signal.addEventListener("abort",resolve,{once:true}));return "cancelled";',
        {
          parameters:
            "| Name | Type | Required | Default | CLI | Description |\n| --- | --- | --- | --- | --- | --- |\n| label | string | yes | | 1 | Invocation label. |",
        },
      ),
    });
    const runtime = new Runtime(await loadCommands(undefined, { cwd: dir }), {
      adapters: {
        observe: (label, context) => {
          seen.set(label, context);
          if (seen.size === 2) ready();
        },
      },
    });
    const http = await startHttp({ runtime });
    t.after(() => http.close());
    const first = await client(http.url + "/mcp"),
      second = await client(http.url + "/mcp");
    const a = new AbortController(),
      b = new AbortController();
    const callA = first.callTool(
      { name: "test", arguments: { label: "first" } },
      undefined,
      {
        signal: a.signal,
      },
    );
    const rejectA = assert.rejects(callA);
    const callB = second.callTool(
      { name: "test", arguments: { label: "second" } },
      undefined,
      {
        signal: b.signal,
      },
    );
    const rejectB = assert.rejects(callB);
    try {
      await entered;
      a.abort();
      await rejectA;
      for (let i = 0; i < 100 && !seen.get("first").signal.aborted; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(seen.get("first").signal.aborted, true);
      assert.equal(seen.get("second").signal.aborted, false);
      b.abort();
      await rejectB;
    } finally {
      a.abort();
      b.abort();
      await first.close();
      await second.close();
    }
  },
);
