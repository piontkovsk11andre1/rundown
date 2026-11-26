import test from "node:test";
import assert from "node:assert/strict";
import { CallbackHost, Runtime } from "../sources/index.mjs";
import { Observability } from "../sources/Observability.mjs";
import { objectSchema, pause } from "./helpers.mjs";

function setup() {
  const controller = new AbortController();
  const records = [];
  const observability = new Observability({
    sink: (record) => records.push(record),
  });
  const context = {
    id: "test-invocation",
    signal: controller.signal,
    registrations: new Set(),
    observability,
    ...observability.scoped("test-invocation"),
  };
  const host = new CallbackHost();
  return { controller, context, host, records };
}
test("registration is transport independent, validates and serializes closures", async () => {
  const { host, context } = setup();
  const values = [];
  const reg = host.register(context, {
    update: {
      inputSchema: objectSchema,
      handler: async ({ value }) => {
        await pause(2);
        values.push(value);
        return values.length;
      },
    },
  });
  assert.equal(host.server, undefined);
  await assert.rejects(reg.call("update", { value: "wrong" }), /integer/);
  assert.deepEqual(
    await Promise.all([
      reg.call("update", { value: 1 }),
      reg.call("update", { value: 2 }),
    ]),
    [1, 2],
  );
  assert.deepEqual(values, [1, 2]);
  await reg.close();
  await reg.close();
  assert.equal(host.registrations.size, 0);
  await assert.rejects(reg.call("update", { value: 3 }), /closed/);
});
test("normal close seals admission and drains already accepted calls", async () => {
  const { host, context } = setup();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const values = [];
  const reg = host.register(context, {
    update: {
      inputSchema: objectSchema,
      handler: async ({ value }) => {
        await gate;
        values.push(value);
      },
    },
  });
  const a = reg.call("update", { value: 1 });
  const b = reg.call("update", { value: 2 });
  const closing = reg.close();
  await assert.rejects(reg.call("update", { value: 3 }), /closed/);
  release();
  await Promise.all([a, b, closing]);
  assert.deepEqual(values, [1, 2]);
});
test("callback failures do not poison the queue or fail unrelated calls", async () => {
  const { host, context } = setup();
  const reg = host.register(context, {
    update: {
      inputSchema: objectSchema,
      handler: ({ value }) => {
        if (value === 1) throw new Error("failed");
        return value;
      },
    },
  });
  await assert.rejects(reg.call("update", { value: 1 }), /failed/);
  assert.equal(await reg.call("update", { value: 2 }), 2);
  await reg.close();
});
test("cancellation rejects queued calls and signals active handlers", async () => {
  const { host, context, controller } = setup();
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const started = [];
  const reg = host.register(context, {
    update: {
      inputSchema: objectSchema,
      handler: async ({ value }, { signal }) => {
        started.push(value);
        entered();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        return value;
      },
    },
  });
  const first = reg.call("update", { value: 1 });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  await ready;
  const queued = reg.call("update", { value: 2 });
  const queuedRejected = assert.rejects(queued, { name: "AbortError" });
  controller.abort();
  await Promise.all([firstRejected, queuedRejected, reg.close()]);
  assert.deepEqual(started, [1]);
  assert.equal(host.registrations.size, 0);
});
test("reporting tools validate declared metrics, protect correlation and share lifetime", async () => {
  const { host, context, records } = setup();
  const added = [];
  const instrument = {
    kind: "counter",
    description: "Completed work",
    attributeKeys: ["kind"],
    add: (...args) => added.push(args),
  };
  const reg = host.register(
    context,
    {},
    { reporting: { logs: true, metrics: { completed: instrument } } },
  );
  assert.deepEqual(
    reg.tools.map((t) => t.name),
    ["report_log", "report_metric"],
  );
  await reg.call("report_log", {
    level: "info",
    message: "Progress",
    fields: { invocationId: "spoof", step: 2 },
  });
  assert.equal(records[0].invocationId, "test-invocation");
  assert.equal(records[0].step, 2);
  await reg.call("report_metric", {
    metric: "completed",
    value: 1,
    attributes: { kind: "task" },
  });
  assert.deepEqual(added, [[1, { kind: "task" }]]);
  for (const input of [
    { metric: "unknown", value: 1 },
    { metric: "completed", value: -1 },
    { metric: "completed", value: 1, attributes: { invocationId: "x" } },
  ])
    await assert.rejects(reg.call("report_metric", input));
  await reg.close();
  await assert.rejects(
    reg.call("report_log", { level: "info", message: "late" }),
    /closed/,
  );
});
test("command completion cleans up registrations created inside module-like calls", async () => {
  let registration;
  const command = {
    name: "test",
    surfaces: ["*"],
    parameters: [],
    validate: () => {},
    handler: async (_args, context) => {
      registration = await context.callbacks.register({
        callback: { inputSchema: { type: "object" }, handler: () => 1 },
      });
      return "done";
    },
  };
  const runtime = new Runtime({ commands: new Map([["test", command]]) });
  try {
    assert.equal(await runtime.invoke("test"), "done");
    assert.equal(registration.state, "closed");
    assert.equal(runtime.callbackHost.registrations.size, 0);
  } finally {
    await runtime.close();
  }
});
test("bounded cancellation stops waiting for uncooperative handlers", async () => {
  const command = {
    name: "test",
    surfaces: ["*"],
    parameters: [],
    validate: () => {},
    handler: () => new Promise(() => {}),
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { graceMs: 10 },
  );
  const controller = new AbortController();
  const running = runtime.invoke("test", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running);
  await runtime.close();
  assert.equal(runtime.active.size, 0);
});

test("callbacks reject missing schemas and self-close instead of deadlocking", async () => {
  const { host, context } = setup();
  assert.throws(
    () => host.register(context, { invalid: { handler: () => 1 } }),
    /schema/i,
  );
  let reg;
  reg = host.register(context, {
    close: { inputSchema: { type: "object" }, handler: () => reg.close() },
  });
  await assert.rejects(reg.call("close", {}), /own registration/);
  await reg.close();
  await host.close();
});

test("closing a host during lazy startup leaves no listening server", async () => {
  const { host, context } = setup();
  const reg = host.register(context, {
    callback: { inputSchema: { type: "object" }, handler: () => 1 },
  });
  const exposing = reg.expose();
  const failed = assert.rejects(exposing, /closed/);
  await host.close();
  await failed;
  assert.equal(host.server, undefined);
  assert.equal(host.registrations.size, 0);
});

test("cancelling one call leaves its registration and owning invocation available", async () => {
  const { host, context } = setup();
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const reg = host.register(context, {
    wait: {
      inputSchema: { type: "object", additionalProperties: false },
      handler: async (_input, { signal }) => {
        started();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        return "stopped";
      },
    },
    echo: { inputSchema: objectSchema, handler: (input) => input.value },
  });
  const controller = new AbortController();
  const pending = reg.call("wait", {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered;
  controller.abort();
  await rejected;
  assert.equal(context.signal.aborted, false);
  assert.equal(reg.state, "open");
  assert.equal(await reg.call("echo", { value: 7 }), 7);
  await reg.close();
  await host.close();
});
