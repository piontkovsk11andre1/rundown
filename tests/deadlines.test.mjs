import test from "node:test";
import assert from "node:assert/strict";
import { Runtime, diagnostic } from "../sources/index.mjs";
import { Observability } from "../sources/Observability.mjs";
import { bounded } from "../sources/Lifecycle.mjs";

test("deadline outcome distinguishes undefined completion and observes late rejection", async () => {
  assert.deepEqual(await bounded(Promise.resolve(undefined), 10), {
    completed: true,
    value: undefined,
  });
  let reject;
  const pending = new Promise((_resolve, no) => {
    reject = no;
  });
  assert.deepEqual(await bounded(pending, 1), { completed: false });
  reject(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

for (const primary of [false, true])
  test(`invocation deadline revokes queued work and ${primary ? "preserves the primary error" : "rejects successful results"}`, async () => {
    let release, registration, context;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const records = [];
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const command = {
      name: "test",
      parameters: [],
      surfaces: ["*"],
      validate: () => {},
      handler: async (_args, ctx) => {
        context = ctx;
        registration = ctx.callbacks.register({
          work: {
            inputSchema: { type: "object" },
            handler: async () => {
              calls.push("active");
              started();
              await gate;
              return 1;
            },
          },
        });
        registration.call("work", {}).catch(() => {});
        registration.call("work", {}).catch(() => {});
        await entered;
        if (primary) throw new Error("original failure");
        return "must not succeed";
      },
    };
    const runtime = new Runtime(
      { commands: new Map([["test", command]]) },
      {
        graceMs: 10,
        observability: new Observability({
          sink: (record) => records.push(record),
        }),
      },
    );
    try {
      await assert.rejects(runtime.invoke("test"), (error) => {
        const value = diagnostic(error);
        if (primary) {
          assert.equal(error.message, "original failure");
          assert.equal(error.cause.message, "original failure");
          assert.equal(value.related[0].code, "RUNDOWN_CLEANUP_TIMEOUT");
        } else assert.equal(error.code, "RUNDOWN_CLEANUP_TIMEOUT");
        assert.ok(value.invocationId);
        return true;
      });
      assert.equal(context.signal.aborted, true);
      assert.equal(registration.signal.aborted, true);
      assert.equal(runtime.callbackHost.registrations.size, 0);
      assert.equal(context.registrations.size, 0);
      assert.ok(
        records.some((record) => record.code === "RUNDOWN_CLEANUP_TIMEOUT"),
      );
      release();
      await registration.tail;
      assert.deepEqual(calls, ["active"]);
    } finally {
      release();
      await runtime.close();
    }
  });

test("shutdown shares one deadline and reports incomplete draining", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let ready;
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  let registration;
  const command = {
    name: "test",
    parameters: [],
    surfaces: ["*"],
    validate: () => {},
    handler: async (_args, context) => {
      registration = context.callbacks.register({
        work: {
          inputSchema: { type: "object" },
          handler: async () => {
            ready();
            await gate;
          },
        },
      });
      registration.call("work", {}).catch(() => {});
      await new Promise((resolve) =>
        context.signal.addEventListener("abort", resolve, { once: true }),
      );
    },
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { graceMs: 20, observability: new Observability({ sink: () => {} }) },
  );
  const invocation = runtime.invoke("test");
  const failed = assert.rejects(invocation);
  await entered;
  const start = performance.now();
  await assert.rejects(
    runtime.close(),
    (error) => error.code === "RUNDOWN_CLEANUP_TIMEOUT",
  );
  assert.ok(performance.now() - start < 500);
  assert.equal(runtime.callbackHost.registrations.size, 0);
  release();
  await failed;
  await registration.tail;
});
