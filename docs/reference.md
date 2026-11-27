# Rundown reference

Version 2.0.0-rc.3.

## Commands

Command catalogs connect declarative definitions. Each command owns its description, parameters, returns and handler body.

**heading:** `## Command: name`

### fields

- Options
- Parameters
- Schema
- Returns
- Handler

### columns

```json
{
  "connections": [
    "File",
    "Description"
  ],
  "options": [
    "Option",
    "Value"
  ],
  "parameters": [
    "Name",
    "Type",
    "Required",
    "Default",
    "CLI",
    "Description"
  ],
  "returns": [
    "Type",
    "Description"
  ]
}
```

### types

```json
{
  "string": "string",
  "path": "string",
  "number": "number",
  "integer": "integer",
  "boolean": "boolean",
  "object": "object",
  "array": "array",
  "null": "null"
}
```

### surfaces

- cli
- http
- mcp
- http-mcp

### rules

- Connections import command definitions, never modules. References are document-relative/absolute paths or explicit npm:package/export specifiers.
- Options and Schema are optional; Parameters, Returns and Handler are required in the listed order.
- CLI uses contiguous positional numbers or --named options. HTTP/MCP use the parameter Name.
- Required is yes/no. Defaults are JSON literals; blank means no default. Required arguments cannot have defaults.
- Simple types and optional JSON Schema validate inputs at each surface boundary. Unknown arguments are rejected.
- Handler contains one js fence with only the async function body. It receives args and context.
- Surfaces defaults to *. A restricted list is an Options row named Surfaces.
- One MCP tool is exposed per permitted command; positional names are project commands, not authoring built-ins.

## Packages and entry points

Source layout is unrestricted. The nearest package.json identifies the project and declares optional rundown.commands and rundown.tests paths; native dependencies remain normal package dependencies.

### manifest

```json
{
  "rundown": {
    "commands": "./commands.md",
    "tests": "./tests"
  }
}
```

### commands

- rundown --init automation/commands.md tests/
- rundown --commands ./automation/commands.md release
- rundown --cwd ./package release
- rundown --test ./specs
- rundown --new-command hello --out tools/greetings
- rundown --commands npm:@example/recipes/commands release

### api

```json
{
  "initProject(catalog, options?)": {
    "returns": "Promise<AuthoringResult>; import from @p10i/rundown/authoring",
    "defaults": "cwd = process.cwd(); options.tests is optional",
    "example": "await initProject('automation/commands.md', {cwd, tests: 'tests/'})",
    "lifetime": "Requires an existing nearest package.json and statically valid command catalog. Tests must be an existing directory or .test.md file. Only supplied manifest entries are changed, atomically against the read revision; equivalent paths are a no-op. No source/dependency/script/lockfile generation."
  }
}
```

### rules

- Discovery walks upward only to the nearest package.json. Missing Rundown entries there do not inherit from an ancestor package.
- --commands overrides command catalog discovery for execution, help, HTTP/MCP hosting, default checks and connected-command authoring. Explicit documents and test paths work without Rundown configuration.
- Manifest entry paths resolve from the containing package.json. Explicit CLI paths and application arguments resolve from --cwd. Connections, module imports and view templates resolve from their declaring document.
- No hidden-directory catalog or test fallback exists. Dot directories have no source-loading meaning; projects may use them for their own artifacts/cache.
- --init <catalog.md> [tests] registers existing paths in the nearest package.json. Supplied entries can reconfigure defaults; omitted tests and unrelated metadata are preserved. Bare --init prints usage. Missing manifests/targets or invalid catalogs fail before writing.
- A tests-only package may declare only rundown.tests. New commands are created beside the selected catalog; standalone module paths remain explicit.
- Use --new-command name --out directory to place its commands.md/module.md pair exactly there, relative to --cwd. Defaults remain beside the selected catalog. Empty catalogs can use any .md filename; catalog context rejects module declarations.
- Explicit npm:package/export references resolve installed package exports for catalogs, Markdown dependencies/loaders, view templates and tests. Plain filesystem paths keep their existing meaning. Resolution uses the declaring document or cwd and never bypasses package exports.
- Registering/connecting npm: sources preserves their specifiers rather than node_modules-relative paths. Authoring destinations must be local catalogs; compose packaged catalogs through Connections instead of editing dependencies.

## Modules

Readable documentation compiles into native ESM. Declarations come from Markdown; JavaScript fences supply method bodies only.

**heading:** `## Method: name`

### fields

- Options
- Parameters
- Returns
- Implementation

### columns

```json
{
  "dependencies": [
    "Source",
    "Kind",
    "Binding",
    "Description"
  ],
  "constants": [
    "Name",
    "Value",
    "Description"
  ],
  "options": [
    "Option",
    "Value"
  ],
  "parameters": [
    "Name",
    "Type",
    "Required",
    "Default",
    "Description"
  ],
  "returns": [
    "Type",
    "Description"
  ]
}
```

### options

```json
{
  "Visibility": [
    "public",
    "private"
  ],
  "Execution": [
    "async",
    "sync"
  ]
}
```

### rules

- Dependencies and Constants are optional H2 sections. Dependencies load with the module as namespace bindings.
- Dependency Kind is markdown or javascript. Markdown references are document-relative/absolute or explicit npm: exports; JavaScript uses normal native ESM specifiers without the npm: prefix.
- Methods default to public and async. Options can select private visibility and sync execution.
- Parameters, Returns and Implementation are required in order. Types use JSDoc notation and do not add module-call runtime validation.
- Constants and parameter defaults use JSON literals. Async return types describe the callable API, for example Promise<string>.
- Each Implementation has exactly one js fence containing a method body, not an export/function declaration.
- Ordinary documentation sections and Examples are allowed. Their code is never included in the generated module.
- Native ESM caching and circular imports apply. Restart long-lived hosts after edits; do not create per-invocation module instances.
- Pass invocation context explicitly as a documented parameter. There is no module initialization-script section.
- rundown.createView(template, data, options?) resolves a do-md view template relative to the declaring document. Return the view to keep the invocation active until explicit close.

## Invocation context

Surface dispatch supplies capabilities to the command handler; modules receive them only through explicit arguments.

### members

- id / invocationId
- workdir
- io (do-md adapter)
- signal (AbortSignal)
- log
- metrics
- callbacks
- adapters
- observability
- run(binding, input)

### api

```json
{
  "context.run(binding, input)": {
    "returns": "Promise<binding result>",
    "defaults": "cwd = context.workdir; signal combines invocation/input signals; active W3C trace context is captured inside the execution span",
    "example": "await context.run(projectBinding, {operation: 'build'})",
    "lifetime": "Binding exposes run(input); preserves its receiver. Already-instrumented adapters use one span, not a second wrapper; invocation-bound adapters cannot cross invocation ownership. Rejects cancelled or completed work. Await the result; JavaScript is not forcibly interrupted."
  }
}
```

### rules

- Use io with do-md public APIs for application documents. Refer to do-md's Skill/reference when authoring its templates.
- Use signal for cooperative cancellation. A path command parameter resolves against workdir, not the declaring module.
- log.info(message, fields) emits human/structured logs. metrics.counter(name).add(value) and metrics.histogram(name).record(value) update declared instruments.
- Invocation-specific values belong in parameters and local variables, not shared module globals.
- Use context.run(binding, input) for project Markdown/native bindings exposing run(input). Injected adapters use the same execution boundary. Provider-specific fields and configuration belong to project-level bindings.
- A harness binding is an ordinary project Markdown module. It can import JavaScript packages or use generic process/HTTP helpers to connect any CLI or service.
- @p10i/rundown/process exports runProcess and ProcessAdapter for bounded scripts without an AI dependency. InvocationContext<YourAdapters> preserves custom adapter signatures.

## Callbacks

Callbacks are runtime-only JavaScript definitions; they have no Markdown declaration section.

### api

```json
{
  "context.callbacks.with(definitions, [options], operation)": {
    "returns": "Promise<operation result>, after accepted calls drain",
    "defaults": "options = {}; no listener until registration.expose(); cleanup grace defaults to the invocation's 5000 ms",
    "example": "await context.callbacks.with(definitions, {reporting: {logs: true}}, async registration => { const endpoint = await registration.expose(); await context.run(binding, {mcp: {callbacks: endpoint.mcp}}); })",
    "lifetime": "Registers before operation; closes/drains on completion or failure, cancels on invocation cancellation. Cleanup timeout revokes the registration. Primary failures retain related cleanup diagnostics."
  },
  "context.callbacks.register(definitions, options?)": {
    "returns": "Registration with call(name,input,{signal?}), expose(), close(), cancel(reason?)",
    "defaults": "options = {}; options.reporting explicitly enables logs and declared metric aliases",
    "example": "const registration = context.callbacks.register(definitions); try { await registration.call('complete', {}); } finally { await registration.close(); }",
    "lifetime": "Use for an explicit lifetime. Invocation completion is fallback cleanup. expose() returns {url,mcp,tools}; close() drains; cancel() rejects queued calls and signals active calls."
  }
}
```

### rules

- context.callbacks.register(definitions, {reporting?}) returns a registration without opening a listener.
- Every callback needs an object JSON inputSchema, a description and a handler. Incoming arguments are validated.
- registration.expose() supplies a scoped MCP configuration and tool definitions to give to an external harness before it connects.
- Registration definitions are fixed and transport-independent. The adapter forwards endpoint details and schemas to the external caller.
- Calls are sequential within one registration; separate registrations may run concurrently. Callback errors return to their caller without automatically failing the command.
- Prefer context.callbacks.with for a lexical lifetime. Use register plus try/finally when explicit lifetime control is needed. Normal close drains accepted calls; invocation completion is automatic cleanup fallback.
- Cancellation signals active work and drops queued calls. Never await closing a registration from inside its own callback.
- Enable reporting with {logs:true, metrics:{alias:instrument}}. External callers cannot create arbitrary metrics or override invocation correlation.
- The harness recipe owns terminal-success policy. A process exit alone need not mean a completion callback was received.

## Observability

Invocation-scoped logging, declared metrics and application spans use the existing observability facade. Commands, callbacks and binding runs are instrumented automatically.

### api

```json
{
  "context.log.info(message, fields?)": {
    "returns": "void",
    "defaults": "fields = {}; also trace/debug/warn/error/fatal; invocation/trace correlation is supplied automatically",
    "example": "context.log.info('Processed document', {path})",
    "lifetime": "Use during the invocation; console logs go to stderr. No logger construction in module methods."
  },
  "context.metrics.counter(name, options?)": {
    "returns": "Counter with add(value, attributes?)",
    "defaults": "options = {}; description, unit and attributeKeys are optional",
    "example": "const completed = context.metrics.counter('documents.completed', {attributeKeys: ['kind']}); completed.add(1, {kind: 'report'});",
    "lifetime": "Declare and reuse instruments; expose only explicit aliases through callback reporting. Counter updates must be finite and nonnegative."
  },
  "context.metrics.histogram(name, options?)": {
    "returns": "Histogram with record(value, attributes?)",
    "defaults": "Same options as counters",
    "example": "context.metrics.histogram('document.duration', {unit: 'ms'}).record(elapsed)",
    "lifetime": "Records finite measurements; reporting cannot invent instruments or arbitrary attributes."
  },
  "context.observability.span(name, fields, operation)": {
    "returns": "Promise<operation result>",
    "defaults": "Parent is the active tracing context",
    "example": "await context.observability.span('document.parse', {path}, () => parseDocument(source))",
    "lifetime": "Awaits the operation and records success/failure. Use for application operations; context.run already creates a binding span and forwards trace context."
  }
}
```

### rules

- RUNDOWN_LOG_FORMAT and RUNDOWN_LOG_LEVEL configure console logs. Standard OTEL_* variables configure exporters for ordinary CLI commands; embedded hosts own SDK setup/shutdown.
- Use @p10i/rundown/observability tracedFetch for HTTP trace injection, and @p10i/rundown/process runProcess with the supplied execution context for subprocesses.
- Project bindings translate trace headers and connection details into their client's protocol; SDK setup is host infrastructure, not per-method code.

## Testing

Ordinary module documents ending in .test.md run through Node's test runner. No additional Markdown grammar or assertion library is introduced.

### commands

- rundown --test
- rundown --test tests/greeting.test.md
- rundown --test --json

### api

```json
{
  "public testMethod(t, context)": {
    "returns": "void or Promise<void>; throw/reject to fail",
    "defaults": "Every public method is a test; private methods are helpers. Parameters may be omitted when unused.",
    "example": "const module = await rundown.loadModule('../example/module.md'); assert.equal(await module.greet('Ada'), 'Hello, Ada!');",
    "lifetime": "t is Node's TestContext; context is a fresh production invocation context. Callbacks drain and cleanup errors fail the test. Files run in isolated processes; ESM state is shared among methods within a file."
  },
  "createTestRuntime(t, options?)": {
    "returns": "Promise<Runtime>; import from @p10i/rundown/testing",
    "defaults": "cwd = worker cwd; omitted entry uses the nearest package's rundown.commands; accepts Runtime options for explicit adapters, IO and observability",
    "example": "const runtime = await testing.createTestRuntime(t, {cwd: context.workdir}); assert.equal(await runtime.invoke('example', {name: 'Ada'}), 'Hello, Ada!');",
    "lifetime": "Registers runtime.close with t.after. invoke uses real command validation and lifecycle; pass {surface,signal} when testing those controls."
  }
}
```

### rules

- Default test selection uses the nearest package.json rundown.tests path, resolved from its manifest directory. An explicit file or directory resolves from --cwd; symlinks and node_modules/.git directories are not traversed.
- Use node:assert/strict and Node's actual t hooks, subtests and mocking facilities. Declare dependencies through the normal table or document-relative rundown.loadModule.
- Test method arguments are positional (t, context); declare both when using the second. Types remain documentation, as in other modules.
- No tests, import/compile errors, assertion failures and cleanup failures exit nonzero. --json prints one report; test stdout/stderr is forwarded to stderr.
- --grace-ms controls invocation cleanup. Tests execute real project code; external substitutes are explicit inputs or adapters, not automatic import rewriting.
- Use --check for static validation, then --test for behavior. Test documents are not catalog Connections and Examples remain non-executable documentation.

## Live views

JSON state rendered through a trusted do-md Markdown template. A returned view keeps its invocation alive until explicit close, failure or cancellation; no new module grammar is introduced.

### commands

- rundown report
- rundown --fullscreen --logs show report
- rundown --json report
- rundown --markdown report
- rundown --check views/report.md.template

### api

```json
{
  "rundown.createView(template, data, options?)": {
    "returns": "Promise<View>; @p10i/rundown/views also exports createView, View and isView",
    "defaults": "Template path is document-relative; options fullscreen=false and logs=show (fullscreen defaults logs to hide). Native createView requires cwd/baseURL for relative paths.",
    "example": "const view = await rundown.createView('./report.md.template', {status: 'Working'}); view.track(() => worker.run(view, context)); return view;",
    "lifetime": "Views created or tracked inside an invocation are owned before handler return. Owned failures interrupt execution and abort its signal; unreturned open views cancel on completion. Return selects display/waiting. Already-closed views render their final snapshot immediately. One invocation owns a view."
  },
  "view.update(patch) / view.replace(data)": {
    "returns": "void; data and revision getters expose snapshots and monotonic revisions",
    "defaults": "update is a shallow top-level merge; replace changes the whole JSON object",
    "example": "view.update({completed: 5});",
    "lifetime": "State must contain finite JSON values. Input/output snapshots prevent mutation without notification. Updates after close/failure/cancellation reject."
  },
  "view.track(operation)": {
    "returns": "Promise<operation result>; accepts a promise or a function returning a value/promise",
    "defaults": "Function operations begin in a microtask; rejection is observed even before the view is returned",
    "example": "view.track(async () => { await process(view, context); view.close(); });",
    "lifetime": "Failure fails the open view and cancels owned invocation work. Success does not close it. Pending work is drained within the invocation cleanup grace after close. Do not await view.done inside a tracked operation and expect its own completion to close the view."
  },
  "view.close() / view.fail(error)": {
    "returns": "void; view.done resolves on close and rejects on failure/cancellation",
    "defaults": "Repeated termination is harmless; the final state remains renderable",
    "example": "view.update({status: 'Completed'}); view.close();",
    "lifetime": "Returning is not completion. Explicit closure seals updates and begins bounded cleanup. Application data such as status='failed' does not itself fail the invocation. Cancellation aborts the invocation signal."
  },
  "view.render(display?)": {
    "returns": "Current snapshot as Markdown, synchronously",
    "defaults": "display.width=80, display.height=24; positive integer dimensions up to 10000",
    "example": "const markdown = view.render({width: 100, height: 30});",
    "lifetime": "do-md templates receive ctx.data and ctx.display. Rendering/resize do not change application state. Templates remain trusted synchronous JavaScript, without an invocation context or workflow effects."
  },
  "view.configure(options) / view.subscribe(listener)": {
    "returns": "configure returns void; subscribe returns unsubscribe",
    "defaults": "options can update fullscreen and logs show/hide; subscribers are invalidation callbacks",
    "example": "view.configure({logs: 'show'});",
    "lifetime": "Changes notify the host; rapid revisions coalesce into redraws. Subscriber callbacks should not throw or mutate the view recursively. Terminal log visibility does not disable telemetry exporters or custom sinks."
  }
}
```

### rules

- Normal CLI values remain plain strings or JSON; undefined produces no normal output. A returned view selects presentation. --json returns final state and --markdown returns final raw Markdown, with direct JavaScript stdout routed to stderr.
- Interactive terminals render styled Markdown live. Noninteractive output waits for closure and emits final Markdown without control sequences. NO_COLOR suppresses color; TERM=dumb disables live control.
- --fullscreen/--no-fullscreen and --logs show|hide override a view's presentation. Inline logs append above the view; full-screen logs use a bounded region. Full-screen uses the alternate screen and restores it on close, failure or cancellation.
- Console and structured-log writes pass through the CLI host while mounted. Inherited subprocess file descriptors bypass JavaScript routing: capture subprocess output through the process helper and log it explicitly when needed.
- Runtime.invoke returns the closed View and accepts onView(view) for embedding. HTTP negotiates final JSON/Markdown using Accept quality and exclusions; unsupported representations fail with 406 before execution. Markdown accepts width/height query inputs. MCP supplies Markdown and structured state. No live HTTP resource index or stream is created.
- Terminal finalization errors preserve an existing invocation failure and are added as related diagnostics. Handler failures abort ongoing invocation work even before view handoff.
- --check compiles literal owner-bound createView templates without executing them; computed/shadowed targets are reported as dynamic. Templates are presentation assets, not Connections or module Dependencies.

## Surfaces

All surfaces share catalog definitions, validation and invocation lifecycle.

### commands

- rundown <project-command> ...arguments
- rndn <project-command> ...arguments
- rundown --serve
- rundown --mcp
- rundown --mcp-http <url>

### rules

- --serve exposes plain HTTP and standard Streamable HTTP MCP at separate routes; --mcp uses stdio.
- --mcp-http is a stdio bridge to a remote Streamable HTTP server. It does not implement deprecated HTTP+SSE.
- HTTP uses GET /commands, GET /commands/{name}, POST /commands/{name}. Command inputs are JSON objects.
- Callbacks have registration-scoped HTTP and MCP endpoints on the shared listener. CLI listeners start lazily.
- Strings print as text on CLI; ordinary other values print as JSON and undefined prints nothing. Returned views render live Markdown or final data under --json. Logs go to stderr; stdio MCP stdout is protocol-only.
- The host workdir determines command discovery. Global flags precede a project command; subsequent arguments belong to that command.

## Debugging and authoring

Check documents without executing them, then use normal invocation and mapped diagnostics to inspect behavior.

### commands

- rundown --init commands.md tests/
- rundown --new-command hello --out tools/hello
- rundown --new-module hello/helper.md
- rundown --connect copied/commands.md
- rundown --check
- rundown --check hello/helper.md
- rundown --compile hello/helper.md --out ./compiled
- rundown --reference modules
- rundown --skill

### rules

- --init registers an existing catalog and optional test target; it never installs dependencies, creates a package or generates source. Paths resolve from --cwd and are stored relative to the nearest manifest. --commands selects temporarily and cannot be combined with registration.
- --new-command creates a command catalog plus companion module beside the selected local catalog or in --out directory, then connects it. --out resolves from --cwd. --new-module creates a standalone module document at its explicit path.
- --connect validates and connects an existing catalog without regenerating it; duplicate names and Connections cycles fail before publication.
- --check compiles reachable Markdown, validates catalogs/schemas and resolves static dependencies without importing or evaluating user JavaScript.
- Literal owner-bound loadModule/loadCommands calls are followed. Computed or shadowed loader calls are reported as dynamic, not falsely certified.
- --check --json returns structured diagnostics. A successful check is not a proof that external services or runtime-only paths work.
- --compile emits inspectable .mjs/.map artifacts without execution. Artifacts are not a standalone distribution.
- --debug-dir writes runtime compilation artifacts. --json-errors selects structured errors.
- RUNDOWN_LOG_FORMAT / RUNDOWN_LOG_LEVEL configure console logs; standard OTEL_* variables configure exporters.
- W3C trace headers propagate through HTTP and external adapters. RUNDOWN_TRACE_CONTEXT is the child-process JSON carrier.
- Cleanup expiry revokes callbacks and reports RUNDOWN_CLEANUP_TIMEOUT; secondary errors are preserved in related diagnostics.
