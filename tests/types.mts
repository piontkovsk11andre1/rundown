import {
  loadModule,
  loadCommands,
  Runtime,
  CallbackHost,
  diagnostic,
  type InvocationContext,
} from "@p10i/rundown";
import { startHttp } from "@p10i/rundown/http";
import { createTestRuntime } from "@p10i/rundown/testing";
import { View, createView, isView, type LiveView } from "@p10i/rundown/views";
import {
  Observability,
  traceCarrier,
  withTraceContext,
  tracedFetch,
} from "@p10i/rundown/observability";
import {
  ProcessAdapter,
  runProcess,
  type ProcessResult,
} from "@p10i/rundown/process";
import {
  initProject,
  newCommand,
  newModule,
  checkProject,
  readSkill,
  type CheckResult,
} from "@p10i/rundown/authoring";
async function use(context: InvocationContext) {
  const view = new View("# Report\n", { completed: 0, status: "Open" });
  view.update({ completed: 1 });
  // @ts-expect-error view update preserves state field types
  view.update({ completed: "wrong" });
  const tracked: number = await view.track(() => 42);
  void tracked;
  const live: LiveView<{ completed: number; status: string }> = view;
  const rendered: string = live.render({ width: 80 });
  void rendered;
  view.close();
  if (isView(view)) void view.data;
  const loadedView = await createView(
    "./report.md.template",
    { status: "Open" },
    { baseURL: import.meta.url, fullscreen: true, logs: "show" },
  );
  loadedView.update({ status: "Closed" });
  loadedView.close();
  const binding = {
    async run(input: { value: number }) {
      return String(input.value);
    },
  };
  const boundResult: string = await context.run(binding, { value: 42 });
  void boundResult;
  // @ts-expect-error context.run preserves the binding's required input
  await context.run(binding, { prompt: "wrong domain" });
  const scopedResult: number = await context.callbacks.with(
    {},
    async (registration) => {
      await registration.expose();
      return 42;
    },
  );
  void scopedResult;
  const reportingResult: string = await context.callbacks.with(
    {},
    { reporting: { logs: true } },
    () => "done",
  );
  void reportingResult;
  void createTestRuntime;
  const registration = context.callbacks.register(
    {
      complete: {
        inputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        handler: (input: { ok: boolean }, call) => {
          call.signal.throwIfAborted();
          return input.ok;
        },
      },
    },
    {
      reporting: {
        logs: true,
        metrics: { completed: context.metrics.counter("tasks.completed") },
      },
    },
  );
  await registration.expose();
  await registration.close();
  const module = await loadModule<{ greet(name?: string): Promise<string> }>(
    "./module.md",
    { baseURL: import.meta.url },
  );
  const result: string = await module.greet();
  // @ts-expect-error module signature rejects numeric names
  await module.greet(5);
  context.metrics.histogram("time").record(5);
  // @ts-expect-error histograms do not increment
  context.metrics.histogram("time").add(1);
  const catalog = await loadCommands(undefined, { cwd: process.cwd() });
  const runtime = new Runtime(catalog, {
    observability: new Observability(),
    adapters: { scripts: new ProcessAdapter() },
  });
  const host = new CallbackHost();
  await host.close({ graceMs: 10 });
  // @ts-expect-error registrations are created through invocation capabilities, not an internal host API
  host.register(context, {});
  const carrier: Record<string, string> = traceCarrier();
  const response: Promise<Response> = withTraceContext(carrier, () =>
    tracedFetch("http://localhost/"),
  );
  void response;
  const related = diagnostic(new Error()).related;
  const codes: string[] | undefined = related?.map((error) => error.code);
  void codes;
  const server = await startHttp({ runtime });
  await server.close();
  const checked: CheckResult = await checkProject({
    cwd: process.cwd(),
    file: new URL("./module.md", import.meta.url),
    kind: "module",
    signal: context.signal,
  });
  const ok: boolean = checked.ok;
  void ok;
  const skill: string = await readSkill();
  void skill;
  await initProject("./commands.md", { cwd: process.cwd(), tests: "./tests" });
  // @ts-expect-error registration requires an explicit catalog path
  await initProject();
  void newModule;
  await newCommand("placed", { cwd: process.cwd(), outDir: "tools/placed" });
  // @ts-expect-error explicit placement is a directory path string
  await newCommand("placed", { outDir: 42 });
  const shell = new ProcessAdapter({ timeoutMs: 1000 });
  const processResult: ProcessResult = await shell.run({
    command: process.execPath,
    args: ["--version"],
  });
  void processResult;
  const typedContext = null as unknown as InvocationContext<{
    shell: ProcessAdapter;
  }>;
  const output: string = (
    await typedContext.adapters.shell.run({
      command: process.execPath,
      args: [],
    })
  ).stdout;
  void output;
  // @ts-expect-error a process adapter needs a command, not an AI prompt
  await typedContext.adapters.shell.run({ prompt: "hello" });
  void runProcess;
  // @ts-expect-error scaffold names are strings
  await newCommand(7);
  return result;
}
void use;
