import test from "node:test";
import assert from "node:assert/strict";
import { Runtime, loadModule } from "../sources/index.mjs";
import { workspace, moduleFile, emptyParams } from "./helpers.mjs";

function runtimeFor(handler, options) {
  return new Runtime(
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
}

test("context.run executes a real Markdown binding with defaults and rejects late work", async (t) => {
  const cwd = await workspace(t, {
    "binding.md": moduleFile(
      "return { cwd: input.cwd, aborted: input.signal.aborted };",
      {
        parameters:
          emptyParams + "\n| input | object | yes | | Invocation input. |",
        returns: "Promise<object>",
      },
    ),
  });
  const binding = await loadModule("./binding.md", { cwd });
  let context;
  const runtime = runtimeFor(
    (_args, ctx) => {
      context = ctx;
      return ctx.run(binding, {});
    },
    { cwd },
  );
  t.after(() => runtime.close());
  assert.deepEqual(await runtime.invoke("test"), { cwd, aborted: false });
  await assert.rejects(context.run(binding, {}), {
    code: "RUNDOWN_INVOCATION_CLOSED",
  });
});

test("context.run preserves receiver, explicit cwd and combined input cancellation", async (t) => {
  class Binding {
    #value = 42;
    async run(input) {
      return { value: this.#value, cwd: input.cwd };
    }
  }
  const runtime = runtimeFor(async (_args, context) => {
    const value = await context.run(Object.freeze(new Binding()), {
      cwd: "/explicit",
    });
    await assert.rejects(
      context.run(new Binding(), { signal: AbortSignal.abort() }),
    );
    await assert.rejects(context.run({}, {}), /run\(input\)/);
    return value;
  });
  t.after(() => runtime.close());
  assert.deepEqual(await runtime.invoke("test"), {
    value: 42,
    cwd: "/explicit",
  });
});

test("callback scope drains accepted calls before returning and keeps reporting options", async (t) => {
  let registration,
    completed = false;
  const runtime = runtimeFor(async (_args, context) => {
    const result = await context.callbacks.with(
      {
        complete: {
          inputSchema: { type: "object" },
          async handler() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            completed = true;
          },
        },
      },
      { reporting: { logs: true } },
      (current) => {
        registration = current;
        assert.ok(current.tools.some((tool) => tool.name === "report_log"));
        void current.call("complete", {});
        return 42;
      },
    );
    assert.equal(completed, true);
    assert.equal(registration.state, "closed");
    return result;
  });
  t.after(() => runtime.close());
  assert.equal(await runtime.invoke("test"), 42);
});

test("callback scope bounds cleanup and retains an operation's primary failure", async (t) => {
  let registration;
  const runtime = runtimeFor(
    (_args, context) =>
      context.callbacks.with(
        {
          stuck: {
            inputSchema: { type: "object" },
            handler: () => new Promise(() => {}),
          },
        },
        async (current) => {
          registration = current;
          current.call("stuck", {}).catch(() => {});
          await new Promise((resolve) => setImmediate(resolve));
          throw new Error("primary operation failed");
        },
      ),
    { graceMs: 15 },
  );
  t.after(() => runtime.close());
  await assert.rejects(runtime.invoke("test"), (error) => {
    assert.equal(error.message, "primary operation failed");
    assert.ok(
      error.related.some((value) => value.code === "RUNDOWN_CLEANUP_TIMEOUT"),
    );
    return true;
  });
  assert.equal(registration.state, "cancelled");
  assert.equal(runtime.callbackHost.registrations.size, 0);
});

test("callback scope cancellation signals active callbacks and releases ownership", async (t) => {
  const controller = new AbortController();
  let started,
    sawAbort = false;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const runtime = runtimeFor((_args, context) =>
    context.callbacks.with(
      {
        wait: {
          inputSchema: { type: "object" },
          handler(_input, call) {
            started();
            return new Promise((resolve) =>
              call.signal.addEventListener(
                "abort",
                () => {
                  sawAbort = true;
                  resolve();
                },
                { once: true },
              ),
            );
          },
        },
      },
      (current) => current.call("wait", {}),
    ),
  );
  t.after(() => runtime.close());
  const operation = runtime.invoke("test", {}, { signal: controller.signal });
  await ready;
  controller.abort("cancelled by test");
  await assert.rejects(operation, { code: "RUNDOWN_CANCELLED" });
  assert.equal(sawAbort, true);
  assert.equal(runtime.callbackHost.registrations.size, 0);
});

test("callback scope cleanup failure rejects an otherwise successful operation", async (t) => {
  const runtime = runtimeFor(
    (_args, context) =>
      context.callbacks.with(
        {
          stuck: {
            inputSchema: { type: "object" },
            handler: () => new Promise(() => {}),
          },
        },
        async (current) => {
          current.call("stuck", {}).catch(() => {});
          await new Promise((resolve) => setImmediate(resolve));
          return 42;
        },
      ),
    { graceMs: 15 },
  );
  t.after(() => runtime.close());
  await assert.rejects(runtime.invoke("test"), {
    code: "RUNDOWN_CLEANUP_TIMEOUT",
  });
  assert.equal(runtime.callbackHost.registrations.size, 0);
});
