import test from "node:test";
import assert from "node:assert/strict";
import { CallbackHost, Runtime, diagnostic } from "../sources/index.mjs";
import { startHttp } from "../sources/Http.mjs";
import { Observability } from "../sources/Observability.mjs";

test("a failed runtime shutdown still closes HTTP listeners", async () => {
  const runtime = new Runtime({ commands: new Map() });
  const http = await startHttp({ runtime });
  const failure = new Error("runtime cleanup failed");
  runtime.close = async () => {
    throw failure;
  };
  await assert.rejects(http.close(), (error) => error === failure);
  assert.equal(http.server.listening, false);
});

test("callback host surfaces cleanup failures after releasing ownership", async () => {
  const host = new CallbackHost();
  const failure = new Error("listener cleanup failed");
  host.owned = true;
  host.server = {
    url: "http://localhost",
    releaseRegistration: () => {},
    close: async () => {
      throw failure;
    },
  };
  await assert.rejects(host.close(), (error) => {
    assert.equal(error.code, "RUNDOWN_CLEANUP_FAILED");
    assert.equal(error.cause, failure);
    assert.equal(
      diagnostic(error).related[0].message,
      "listener cleanup failed",
    );
    return true;
  });
  assert.equal(host.server, undefined);
});

test("cleanup logging failures do not replace the command's primary exception", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let registration;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
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
            entered();
            await gate;
          },
        },
      });
      registration.call("work", {}).catch(() => {});
      await started;
      throw new Error("primary failure");
    },
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    {
      graceMs: 5,
      observability: new Observability({
        sink: () => {
          throw new Error("log sink failed");
        },
      }),
    },
  );
  try {
    await assert.rejects(runtime.invoke("test"), (error) => {
      assert.equal(error.message, "primary failure");
      const value = diagnostic(error);
      assert.equal(value.related[0].code, "RUNDOWN_CLEANUP_TIMEOUT");
      assert.equal(value.related[0].related[0].message, "log sink failed");
      return true;
    });
  } finally {
    release();
    await registration.tail;
    await runtime.close();
  }
});
