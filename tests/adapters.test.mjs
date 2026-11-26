import test from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../sources/index.mjs";
import { ProcessAdapter } from "../sources/Process.mjs";
import { workspace } from "./helpers.mjs";

test("generic process adapters need no prompt and inherit working directory/cancellation", async (t) => {
  const cwd = await workspace(t);
  const command = {
    name: "test",
    parameters: [],
    surfaces: ["*"],
    validate: () => {},
    handler: async (_args, context) =>
      context.adapters.shell.run({
        command: process.execPath,
        args: ["-e", "console.log(process.cwd())"],
      }),
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { cwd, adapters: { shell: new ProcessAdapter() } },
  );
  try {
    assert.equal((await runtime.invoke("test")).stdout.trim(), cwd);
  } finally {
    await runtime.close();
  }
});

test("instrumentation preserves private/prototype methods and frozen adapter receivers", async () => {
  class Adapter {
    #value = "value";
    prepare() {
      return this.#value;
    }
    async run({ label }) {
      return this.#value + label;
    }
  }
  const original = new Adapter();
  const frozen = Object.freeze({
    async run({ label }) {
      return "frozen" + label;
    },
  });
  const command = {
    name: "test",
    parameters: [],
    surfaces: ["*"],
    validate: () => {},
    handler: async (_args, context) => ({
      prepared: context.adapters.custom.prepare(),
      classed: context.adapters.custom instanceof Adapter,
      value: await context.adapters.custom.run({ label: "!" }),
      frozen: await context.adapters.frozen.run({ label: "!" }),
    }),
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { adapters: { custom: original, frozen } },
  );
  try {
    assert.deepEqual(await runtime.invoke("test"), {
      prepared: "value",
      classed: true,
      value: "value!",
      frozen: "frozen!",
    });
  } finally {
    await runtime.close();
  }
});

test("adapter capabilities cannot start new work after their invocation finishes", async () => {
  let context,
    calls = 0;
  const adapter = {
    async run() {
      calls++;
      return 1;
    },
  };
  const command = {
    name: "test",
    parameters: [],
    surfaces: ["*"],
    validate: () => {},
    handler: async (_args, ctx) => {
      context = ctx;
      return ctx.adapters.generic.run({ operation: "inspect" });
    },
  };
  const runtime = new Runtime(
    { commands: new Map([["test", command]]) },
    { adapters: { generic: adapter } },
  );
  try {
    assert.equal(await runtime.invoke("test"), 1);
    await assert.rejects(
      context.adapters.generic.run({ operation: "late" }),
      (error) => error.code === "RUNDOWN_INVOCATION_CLOSED",
    );
    assert.equal(calls, 1);
  } finally {
    await runtime.close();
  }
});
