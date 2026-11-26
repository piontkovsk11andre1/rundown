import test from "node:test";
import assert from "node:assert/strict";
import { View, createView } from "../sources/Views.mjs";
import { Runtime, loadModule } from "../sources/index.mjs";
import { workspace, moduleFile } from "./helpers.mjs";
import { checkProject } from "../sources/Authoring.mjs";

const source =
  "# Report\n\n{% doc.write(ctx.data.status); %}\n\nWidth: {% doc.write(ctx.display.width); %}\n";
const turn = () => new Promise((resolve) => setImmediate(resolve));
function runtimeFor(handler, options = {}) {
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

test("views snapshot JSON data, shallow-update explicitly and render with independent display inputs", () => {
  const data = { status: "Working", nested: { count: 1 } };
  const view = new View(source, data);
  data.nested.count = 99;
  const read = view.data;
  read.nested.count = 100;
  assert.equal(view.data.nested.count, 1);
  const revisions = [];
  const unsubscribe = view.subscribe(() => revisions.push(view.revision));
  view.update({ status: "Done", nested: { other: true } });
  assert.deepEqual(view.data, { status: "Done", nested: { other: true } });
  assert.match(view.render({ width: 40 }), /Width: 40/);
  assert.match(view.render({ width: 100 }), /Width: 100/);
  assert.deepEqual(revisions, [1]);
  assert.equal(view.revision, 1);
  unsubscribe();
  view.close();
  view.close();
  assert.throws(() => view.update({ status: "Late" }), {
    code: "RUNDOWN_VIEW_CLOSED",
  });
  assert.match(view.render(), /Done/);
  assert.throws(() => view.render({ width: 0 }), {
    code: "RUNDOWN_VIEW_DISPLAY",
  });
});

test("view JSON validation rejects lossy values and preserves special own keys", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const invalid of [
    [],
    null,
    { value: undefined },
    { value: Infinity },
    { value: new Date() },
    { value: () => {} },
    cyclic,
  ])
    assert.throws(() => new View(source, invalid), {
      code: "RUNDOWN_VIEW_DATA",
    });
  const view = new View(
    source,
    JSON.parse('{"__proto__":{"value":42},"status":"safe"}'),
  );
  assert.equal(Object.hasOwn(view.data, "__proto__"), true);
  assert.equal(view.data.__proto__.value, 42);
  view.close();
});

test("subscriber failures fail the document without preventing other invalidations", async () => {
  const view = new View(source, { status: "Open" });
  let observed = 0;
  view.subscribe(() => {
    throw new Error("display failed");
  });
  view.subscribe(() => {
    observed++;
  });
  view.update({ status: "Updated" });
  await assert.rejects(view.done, /display failed/);
  assert.equal(observed, 1);
  assert.equal(view.state, "failed");
});

test("static view checks resolve literals and compile templates without executing their code", async (t) => {
  const cwd = await workspace(t, {
    "module.md": moduleFile(
      'return rundown.createView("./report.md.template", {});',
      { returns: "Promise<object>" },
    ),
    "report.md.template": "{% throw new Error('must not execute'); %}",
    "bad.md.template": "{% const = ; %}",
    "missing.md": moduleFile(
      'return rundown.createView("./missing.md.template", {});',
      { returns: "Promise<object>" },
    ),
  });
  const checked = await checkProject({ cwd, file: "module.md" });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.ok(checked.files.some((file) => file.kind === "view"));
  assert.equal(
    (await checkProject({ cwd, file: "report.md.template" })).ok,
    true,
  );
  assert.equal(
    (await checkProject({ cwd, file: "bad.md.template" })).ok,
    false,
  );
  assert.equal((await checkProject({ cwd, file: "missing.md" })).ok, false);
});

test("owner-bound creation resolves templates relative to Markdown, not invocation cwd", async (t) => {
  const cwd = await workspace(t, {
    "nested/module.md": moduleFile(
      'return rundown.createView("./report.md.template", {status: "Bound"});',
      { returns: "Promise<object>" },
    ),
    "nested/report.md.template": source,
  });
  const module = await loadModule("./nested/module.md", { cwd });
  const view = await module.run();
  assert.match(view.render(), /Bound/);
  view.close();
  const loaded = await createView(
    "./nested/report.md.template",
    { status: "Explicit" },
    { cwd },
  );
  assert.match(loaded.render(), /Explicit/);
  loaded.close();
});

test("returning an open view keeps invocation capabilities alive until explicit close", async (t) => {
  let view, context;
  const runtime = runtimeFor((_args, ctx) => {
    context = ctx;
    view = new View(source, { status: "Open" });
    return view;
  });
  t.after(() => runtime.close());
  let mounted = false,
    finished = false;
  const result = runtime
    .invoke(
      "test",
      {},
      {
        onView(current) {
          mounted = current === view;
        },
      },
    )
    .then((value) => {
      finished = true;
      return value;
    });
  await turn();
  assert.equal(mounted, true);
  assert.equal(finished, false);
  assert.equal(
    await context.run(
      {
        async run() {
          return 42;
        },
      },
      {},
    ),
    42,
  );
  const registration = context.callbacks.register({});
  view.track(Promise.resolve());
  await turn();
  assert.equal(
    finished,
    false,
    "successful attached work does not close the view",
  );
  view.update({ status: "Finished" });
  view.close();
  assert.equal(await result, view);
  assert.equal(registration.state, "closed");
  await assert.rejects(context.run({ async run() {} }, {}), {
    code: "RUNDOWN_INVOCATION_CLOSED",
  });
});

test("already-closed views finish immediately and cannot be adopted by another invocation", async (t) => {
  const view = new View(source, { status: "Final" });
  view.close();
  const runtime = runtimeFor(() => view);
  t.after(() => runtime.close());
  assert.equal(await runtime.invoke("test"), view);
  await assert.rejects(runtime.invoke("test"), { code: "RUNDOWN_VIEW_OWNED" });
  assert.equal(view.state, "closed");
});

test("tracked failures fail views and retain template locations", async (t) => {
  const runtime = runtimeFor(() => {
    const view = new View(source, { status: "Open" });
    view.track(async () => {
      await turn();
      throw new Error("worker failed");
    });
    return view;
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.invoke("test"), /worker failed/);
  const broken = new View(
    "# Broken\n{% throw new Error('bad template'); %}\n",
    {},
    { file: "report.md.template" },
  );
  assert.throws(
    () => broken.render(),
    (error) => {
      assert.ok(
        error.locations.some(
          (location) =>
            location.source === "report.md.template" &&
            location.range.start.line === 2,
        ),
      );
      return true;
    },
  );
  broken.close();
});

test("cancellation freezes an open view and signals tracked work", async (t) => {
  const controller = new AbortController();
  let view,
    observed = false;
  const runtime = runtimeFor((_args, context) => {
    view = new View(source, { status: "Open" });
    view.track(
      new Promise((resolve) =>
        context.signal.addEventListener(
          "abort",
          () => {
            observed = true;
            resolve();
          },
          { once: true },
        ),
      ),
    );
    return view;
  });
  t.after(() => runtime.close());
  const operation = runtime.invoke("test", {}, { signal: controller.signal });
  await turn();
  controller.abort();
  await assert.rejects(operation, { code: "RUNDOWN_CANCELLED" });
  assert.equal(observed, true);
  assert.equal(view.state, "cancelled");
  assert.throws(() => view.replace({}), { code: "RUNDOWN_VIEW_CLOSED" });
});

test("close bounds unfinished attached work and observes failures after closure", async (t) => {
  for (const lateFailure of [false, true]) {
    const runtime = runtimeFor(
      () => {
        const view = new View(source, { status: "Closed" });
        view.track(
          lateFailure
            ? turn().then(() => {
                throw new Error("late failure");
              })
            : new Promise(() => {}),
        );
        view.close();
        return view;
      },
      { graceMs: 20 },
    );
    t.after(() => runtime.close());
    await assert.rejects(runtime.invoke("test"), (error) => {
      assert.equal(
        error.code,
        lateFailure ? "RUNDOWN_CLEANUP_FAILED" : "RUNDOWN_CLEANUP_TIMEOUT",
      );
      if (lateFailure) assert.match(error.related[0].message, /late failure/);
      return true;
    });
  }
});
