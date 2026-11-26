import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Runtime, loadCommands } from "../sources/index.mjs";
import { View } from "../sources/Views.mjs";
import { TerminalHost } from "../sources/Terminal.mjs";
import { Observability } from "../sources/Observability.mjs";
import { startHttp } from "../sources/Http.mjs";
import {
  initProject,
  connectCatalog,
  newCommand,
} from "../sources/Authoring.mjs";
import { runProcess } from "../sources/Process.mjs";
import { workspace, moduleFile } from "./helpers.mjs";

const runtimeFor = (handler, options = {}) =>
  new Runtime(
    {
      entry: "test",
      commands: new Map([
        [
          "test",
          {
            name: "test",
            parameters: [],
            surfaces: ["*"],
            validate() {},
            handler,
          },
        ],
      ]),
    },
    options,
  );
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("handler failure before view handoff cancels and drains attached work", async (t) => {
  let view,
    signal,
    timer,
    drained = false;
  const runtime = runtimeFor(async (_args, context) => {
    view = new View("# Pending", {});
    signal = context.signal;
    view.track(
      new Promise((resolve) => {
        timer = setInterval(() => {}, 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearInterval(timer);
            drained = true;
            resolve();
          },
          { once: true },
        );
      }),
    );
    throw new Error("primary handler failure");
  });
  t.after(async () => {
    clearInterval(timer);
    await runtime.close();
  });
  await assert.rejects(
    runtime.invoke("test"),
    (error) =>
      error.message === "primary handler failure" &&
      error.code === "RUNDOWN_EXECUTION",
  );
  assert.equal(signal.aborted, true);
  assert.equal(drained, true);
  assert.equal(view.state, "failed");
  assert.equal(runtime.active.size, 0);
});

test("tracked failure before handoff interrupts a handler that has not returned", async (t) => {
  const runtime = runtimeFor(
    async () => {
      const view = new View("# Pending", {});
      view.track(async () => {
        await turn();
        throw new Error("tracked work failed first");
      });
      await new Promise(() => {});
    },
    { graceMs: 30 },
  );
  t.after(() => runtime.close());
  await assert.rejects(
    runtime.invoke("test"),
    (error) =>
      error.code === "RUNDOWN_EXECUTION" &&
      error.message === "tracked work failed first",
  );
});

test("unreturned open views are cancelled on success; concurrent invocations retain separate ownership", async (t) => {
  const views = [];
  const runtime = runtimeFor(async (_args, context) => {
    const view = new View("# Pending", {});
    views.push(view);
    view.track(
      new Promise((resolve) =>
        context.signal.addEventListener("abort", resolve, { once: true }),
      ),
    );
    await turn();
    return "ordinary result";
  });
  t.after(() => runtime.close());
  assert.deepEqual(
    await Promise.all([runtime.invoke("test"), runtime.invoke("test")]),
    ["ordinary result", "ordinary result"],
  );
  assert.ok(views.every((view) => view.state === "cancelled"));
});

test("callbacks invoked outside the handler retain resource ownership", async (t) => {
  let registration,
    rootView,
    childView,
    stopped = false;
  const runtime = runtimeFor((_args, context) => {
    rootView = new View("# Root", {});
    registration = context.callbacks.register({
      create: {
        inputSchema: { type: "object" },
        handler() {
          childView = new View("# Child", {});
          childView.track(
            new Promise((resolve) =>
              context.signal.addEventListener(
                "abort",
                () => {
                  stopped = true;
                  resolve();
                },
                { once: true },
              ),
            ),
          );
          return { ok: true };
        },
      },
    });
    return rootView;
  });
  t.after(() => runtime.close());
  const invocation = runtime.invoke("test");
  await turn();
  await registration.call("create", {});
  rootView.close();
  await invocation;
  assert.equal(childView.state, "cancelled");
  assert.equal(stopped, true);
});

class Stream extends EventEmitter {
  isTTY = true;
  columns = 40;
  rows = 12;
  text = "";
  write(chunk) {
    this.text += String(chunk);
    return true;
  }
}
test("terminal finalization preserves invocation failure and attaches rendering diagnostics", async (t) => {
  const stdout = new Stream(),
    stderr = new Stream();
  const host = new TerminalHost({ stdout, stderr });
  const original = stdout.write;
  const runtime = runtimeFor(
    () => {
      const view = new View(
        "{% if(ctx.data.bad) throw new Error('final render failed'); %}\n# Report",
        { bad: false },
      );
      view.track(new Promise(() => {}));
      view.track(async () => {
        await turn();
        view.update({ bad: true });
        view.close();
      });
      return view;
    },
    { graceMs: 15, observability: new Observability({ sink() {} }) },
  );
  t.after(() => runtime.close());
  let primary;
  try {
    await runtime.invoke("test", {}, { onView: (view) => host.mount(view) });
  } catch (error) {
    primary = error;
  } finally {
    host.close(primary);
  }
  assert.equal(primary.code, "RUNDOWN_CLEANUP_TIMEOUT");
  assert.ok(
    primary.related.some(
      (error) =>
        error.code === "DO_MD_TEMPLATE_ERROR" &&
        /final render failed/.test(error.message),
    ),
  );
  assert.notEqual(
    stdout.write,
    original,
    "original is the mounted interceptor",
  );
  assert.equal(stdout.listenerCount("resize"), 0);
});

test("empty catalogs are independent of filename across loading, registration and connection", async (t) => {
  const cwd = await workspace(t, {
    "package.json": JSON.stringify({ private: true }),
    "entry.md": "# Empty catalog\n",
    "other.md": "# Another empty catalog\n",
    "module.md": moduleFile("return 1;"),
  });
  await initProject("entry.md", { cwd });
  await connectCatalog("other.md", { cwd });
  assert.equal((await loadCommands(undefined, { cwd })).commands.size, 0);
  await assert.rejects(initProject("module.md", { cwd }), {
    code: "RUNDOWN_AUTHORING",
  });
  await assert.rejects(connectCatalog("module.md", { cwd }), {
    code: "RUNDOWN_AUTHORING",
  });
});

test("context.run uses exactly one adapter span and enforces wrapper ownership", async (t) => {
  const spans = [];
  class Capture extends Observability {
    span(name, fields, operation, ...rest) {
      spans.push([name, fields.adapter]);
      return super.span(name, fields, operation, ...rest);
    }
  }
  let bound;
  const runtime = runtimeFor(
    (_args, context) => {
      bound = context.adapters.worker;
      return context.run(bound, {});
    },
    {
      observability: new Capture({ sink() {} }),
      adapters: {
        worker: Object.freeze({
          async run() {
            return 42;
          },
        }),
      },
    },
  );
  t.after(() => runtime.close());
  assert.equal(await runtime.invoke("test"), 42);
  assert.deepEqual(
    spans.filter(([name]) => name === "rundown.adapter"),
    [["rundown.adapter", "worker"]],
  );
  const other = runtimeFor((_args, context) => context.run(bound, {}));
  t.after(() => other.close());
  await assert.rejects(other.invoke("test"), { code: "RUNDOWN_ADAPTER_OWNER" });
  const registryReuse = runtimeFor(
    (_args, context) => context.run(context.adapters.reused, {}),
    { adapters: { reused: bound } },
  );
  t.after(() => registryReuse.close());
  await assert.rejects(registryReuse.invoke("test"), {
    code: "RUNDOWN_ADAPTER_OWNER",
  });
});

test("HTTP honors quality, exclusions and wildcard specificity before execution", async (t) => {
  let executions = 0;
  const runtime = runtimeFor(() => {
    executions++;
    const view = new View("# Final", { ok: true });
    view.close();
    return view;
  });
  const http = await startHttp({ runtime });
  t.after(() => http.close());
  for (const [accept, format] of [
    ["application/json, text/markdown;q=0", "application/json"],
    ["application/json;q=1, text/markdown;q=0.2", "application/json"],
    ["application/json;q=0.2, text/markdown;q=1", "text/markdown"],
    ["text/markdown;q=0, */*;q=1", "application/json"],
    ["*/*", "application/json"],
    ["text/markdown ; q=1", "text/markdown"],
  ]) {
    const response = await fetch(http.url + "/commands/test", {
      method: "POST",
      body: "{}",
      headers: { accept },
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith(format));
    await response.text();
  }
  const before = executions;
  const response = await fetch(http.url + "/commands/test", {
    method: "POST",
    body: "{}",
    headers: { accept: "application/json;q=0,text/markdown;q=0" },
  });
  assert.equal(response.status, 406);
  assert.equal(executions, before);
});

test("new-command --out chooses an exact directory relative to --cwd", async (t) => {
  const cwd = await workspace(t, {
    "commands.md": "# Project catalog\n",
    "nested/keep": "",
  });
  const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
  await runProcess(
    process.execPath,
    [
      bin,
      "--out",
      "custom/welcome #1",
      "--cwd",
      cwd + "/nested",
      "--new-command",
      "hello",
    ],
    { cwd },
  );
  const source = await readFile(cwd + "/commands.md", "utf8");
  assert.match(source, /nested\/custom\/welcome%20%231\/commands.md/);
  const catalog = await loadCommands(undefined, { cwd });
  const runtime = new Runtime(catalog, { cwd });
  t.after(() => runtime.close());
  assert.equal(await runtime.invoke("hello"), "hello is ready.");
  await newCommand("second", { cwd, outDir: "tools/second" });
  assert.match(
    await readFile(cwd + "/commands.md", "utf8"),
    /tools\/second\/commands.md/,
  );
});
