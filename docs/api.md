# API, surfaces and lifecycle

## Loaders

`loadModule(specifier, {baseURL?, cwd?, signal?, outDir?})` returns the native ESM
namespace. Relative paths outside compiled Markdown require baseURL or cwd.
Inside a document, the injected `rundown` loaders bind baseURL to that document.
Explicit `npm:package/export` specifiers resolve installed package exports using
that baseURL or cwd. The same syntax works for catalogs, Markdown Dependencies,
templates and tests. Plain filesystem paths are not guessed as package names;
JavaScript Dependencies continue using normal native package specifiers.
Canonical real file URLs provide module identity; query/fragment cache busting is
not supported. `import.meta.url` remains the Markdown document URL. A signal can
prevent loading, but does not forcibly interrupt native ESM evaluation.

Each loaded Markdown URL retains one coherent artifact: source, declarations,
executable exports and map. Repeated catalog loads reuse that artifact, even if
the file has changed on disk. Static checking/compile-only read fresh source but
never replace an already loaded executable's diagnostic map. Restart is required
to execute edited definitions. Public catalog metadata is copied from the artifact
so caller edits do not mutate the cached compilation.

`loadCommands(entry?, options)` returns `{entry, commands}`. Omitted entry uses
`rundown.commands` in the nearest package.json, without ancestor inheritance or a
hidden-directory fallback. Manifest paths are relative to the package; explicit
entry paths resolve against cwd/baseURL. Its map contains descriptions, parameters, return
types, surface restrictions, input schemas and callable handlers. Connections are
deduplicated by canonical file URL. Cycles and duplicate command names are errors.
No handler runs during discovery or help generation.

## Runtime

`new Runtime(catalog, {cwd?, io?, observability?, callbackHost?, adapters?, graceMs?})`
owns invocation dispatch and cleanup. `invoke(name, args, {surface?, signal?})`
validates surface and arguments, applies defaults, creates an invocation context,
awaits the handler and closes owned registrations. Return values are the handler's
values. Each invocation has independent identity and cancellation, while imported
module namespaces are shared. `close()` aborts active invocations and waits a
bounded cleanup grace period (default 5000 ms).

A returned View extends invocation lifetime until explicit close, failure or
cancellation. `invoke` returns the final View after bounded work/callback cleanup;
`onView(view)` in its options lets embedding hosts attach before closure. The CLI,
HTTP and MCP expose final state/Markdown rather than serializing the capability.
See [live views](views.md) and `rundown --reference views` for the complete contract.
View creation/tracking inside an invocation acquires ownership immediately, even
before return. Handler/owned-view failures abort ongoing work without changing the
primary failure into cancellation; all owned views drain during bounded cleanup.
Unreturned open views cancel at completion. Async resource ownership does not change
module namespace identity or make business inputs implicit.

Shutdown uses one monotonic deadline across invocation draining and callback-host
cleanup. Expiry revokes registrations, aborts their signals and rejects queued
calls before returning. A handler result is not reported as successful if its
owned cleanup expires: the invocation rejects with `RUNDOWN_CLEANUP_TIMEOUT`.
An existing primary failure remains primary; secondary cleanup failures appear
in its `related` diagnostics. Cleanup failures use `RUNDOWN_CLEANUP_FAILED`.
Unfinished JavaScript stays observed but cannot admit new callback work. HTTP
listeners still close when runtime cleanup reports an error.

Context includes `id`, `invocationId`, `workdir`, do-md `io`, `signal`, `log`,
`metrics`, `callbacks`, injected `adapters` and the observability facade.
Adapters with a `run` method receive invocation-scoped tracing wrappers. Core
execution supplies harness-neutral capabilities; integration code and provider
selection belong to the consuming project.

Adapter inputs are domain-specific. The wrapper supplies default cwd, combines
the invocation/input AbortSignals, and captures trace context inside its span.
Custom prototype/private methods and frozen adapters retain their original receiver.
New adapter work is rejected after invocation completion. `ExternalAdapter<Input,
Output>` and `InvocationContext<Adapters>` retain domain signatures. Provider
request types, command-line flags, configuration and response semantics are defined
by the project, not by the common adapter interface.

### Running project bindings

Use `context.run(binding, input)` for a project Markdown module or native object
that exposes `run(input)`. It returns the binding's result and uses the same
execution boundary as injected adapters:

```js
await context.run(projectBinding, {
  operation: "build",
  target: "release",
});
```

Rundown defaults `input.cwd` to `context.workdir`, combines an optional input signal
with the invocation signal, creates an execution span and captures its W3C
`traceContext`. The binding retains its original receiver. An explicit cwd is
preserved; an active tracing carrier takes precedence over an input carrier.
Cancelled invocations and calls started after invocation completion are rejected.
Await execution; the binding remains responsible for honoring the supplied signal.
The helper does not infer domain-specific inputs, completion policy or retries.
Passing an already-instrumented `context.adapters` binding uses its existing name
and one execution span. Such wrappers belong to their invocation and cannot be
reused through another invocation or adapter registry.

A harness binding can be a normal Markdown module under `ai/harness` or
another project directory. Declare native package/process/HTTP dependencies and
implement the binding's methods there. The callback example includes a deterministic
project-owned MCP client to demonstrate this; it is not a built-in export.

`@p10i/rundown/process` exports `runProcess(command, argv, options)` and
`ProcessAdapter.run({command,args,...options})`. Options include cwd, env, signal,
timeoutMs, maxBytes and traceContext. It bounds output/deadlines and waits for child
termination. It never implicitly invokes a shell; Windows batch wrappers require
an explicit executable/shell command. Runtime tooling invokes npm's JS entry for
portable argument handling. POSIX cancellation targets the process group; Windows
terminates the child and does not claim equivalent grandchild-tree handling.
`CallbackHost` configures and owns connectivity; registrations are created only
through `context.callbacks.register`, not through its internal host machinery.
Its public `close({graceMs?})` can also bound standalone host shutdown.

## Callbacks

Prefer a scoped registration when its lifetime fits one operation:

```js
await context.callbacks.with(
  definitions,
  { reporting: { logs: true } },
  async (registration) => {
    const exposure = await registration.expose();
    await context.run(projectBinding, {
      mcp: { callbacks: exposure.mcp },
    });
  },
);
// Accepted callbacks have drained before checking application outcomes here.
```

`context.callbacks.with(definitions, operation)` omits the optional settings. Both
forms return the operation's value after closing and draining the registration.
Invocation cancellation cancels queued calls and signals active calls. Scope
cleanup is bounded by the invocation's cleanup grace, using its existing shutdown
deadline when active. Expiry revokes the registration and fails with
`RUNDOWN_CLEANUP_TIMEOUT`; other cleanup failures use `RUNDOWN_CLEANUP_FAILED`.
An operation failure remains primary, with cleanup failures in related diagnostics.
Registration does not open a listener; exposure is still explicit.

For an explicit lifetime spanning multiple operations, use `register` and close it
in `finally`:

```js
const completed = context.metrics.counter("tasks.completed", {
  description: "Finished tasks",
  attributeKeys: ["kind"],
});
const registration = context.callbacks.register(
  {
    complete: {
      description: "Report the task outcome.",
      inputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      handler(input, callContext) {
        return { accepted: input.ok };
      },
    },
  },
  { reporting: { logs: true, metrics: { completed } } },
);
try {
  const exposure = await registration.expose();
  // Give exposure.mcp and exposure.tools to an external harness.
} finally {
  await registration.close();
}
```

Registration is synchronous and starts no listener. Schemas must describe objects,
including callbacks without arguments. `expose()` lazily provides `{url, mcp,
tools}`. Every registration gets a unique scoped URL on a shared server. Tools
include its individual callbacks and enabled `report_log` / `report_metric` tools.
Definitions are fixed for that lifetime, so initial discovery needs no dynamic
tool-list refresh. Registration-specific endpoints never expose other invocations.

`call(name, input, {signal?})` validates and queues a call. Calls are serialized per
registration; separate registrations may execute concurrently. Handler failures
return to the caller and do not poison the queue or fail the owning command.
The second handler argument supplies signal, invocationId, log and metrics. Its
signal combines invocation, registration and optional individual-call cancellation.
Cancelling one callback call does not cancel the registration or owning command.

Normal `close()` seals admission and drains accepted calls. Cancellation rejects
queued calls, signals active handlers and revokes external routing. Cleanup is
bounded by the invocation grace period; arbitrary JavaScript cannot be forcibly
stopped in-process. Methods that create registrations do not own their lifetime:
returning from a module method leaves them active until closed or the command ends.
Callbacks must not await closing their own registration from inside its handler,
since closure waits for accepted handlers to finish.

The temporary server remains available for its owning runtime and is closed by
`Runtime.close()`. `--serve` reuses its existing server. Remote harnesses need an
explicitly reachable bind/public URL; adapters only select connection details,
not which surfaces are allowed to invoke a callback.

## HTTP

| Route                       | Operation                                          |
| --------------------------- | -------------------------------------------------- |
| GET /commands               | Discover permitted HTTP commands.                  |
| GET /commands/{name}        | Describe one command.                              |
| POST /commands/{name}       | Execute with a JSON argument object.               |
| POST /callbacks/{id}/{name} | Invoke one live callback.                          |
| /mcp                        | Standard Streamable HTTP command endpoint.         |
| /callbacks/{id}/mcp         | Standard Streamable HTTP scoped callback endpoint. |

Plain HTTP returns `{ok:true,result}` or `{ok:false,error}`. Invalid inputs use
400, unavailable definitions 404, surface exclusions 403, and execution failures 500. Bodies are limited to 1 MiB on plain HTTP. Disconnecting an unfinished plain
HTTP command response aborts its invocation. Completed effects are never undone.
Serialization rejects unsupported JSON values rather than silently dropping them.

MCP uses standard protocol envelopes and tool errors. Each command is a tool;
input descriptions/schemas come from its document. Streamable HTTP retains
protocol sessions so cancellation notifications reach the correct in-flight
request, independently for each client. Registrations still belong to the
invocation, not a protocol session. POST returns JSON; optional GET/SSE listening
is not offered. DELETE terminates a protocol session. Each listener admits up to
256 sessions, pruning inactive five-minute-old sessions when admitting new ones.
Registration closure retires its scoped sessions after accepted responses finish.
No execution retries are performed by Rundown. Protocol interoperability follows
the pinned MCP SDK's supported protocol versions.

## Diagnostics

Terminal finalization follows the same primary/related-error policy as runtime
cleanup. A final rendering failure cannot replace an existing invocation failure.

Surface diagnostics contain `code`, `message`, `locations` and invocationId when
available. Existing do-md diagnostics and causes are preserved. Native errors are
mapped through compiler source maps; the original exception remains `cause`.
Generated glue is unmapped. Console error output uses readable source frames;
`--json-errors` selects a structured CLI envelope. JS stacks are not copied into
normal HTTP/MCP results.

Filesystem and native module-resolution failures use `RUNDOWN_RESOLUTION`, retain
the original cause, and include available caller/connection processing locations.
An unavailable source has a context location with no invented snippet or exact
offset. Grammar failures retain do-md's diagnostic code and locations. Native
and frozen exceptions are wrapped without mutating their original objects.
Callback error envelopes carry the owning invocation ID when it is available.
Cancellation is classified as `RUNDOWN_CANCELLED` even when the caller's abort
reason is an arbitrary JavaScript value.

The CLI's `--grace-ms` sets the shutdown grace period. On an interrupt, cooperative
cleanup runs first; a process-level deadline terminates lingering JavaScript
handles. Embedding the library never forcibly exits the host process.

## Distributed tracing

HTTP extracts W3C `traceparent` / `tracestate` independently for each request,
starting from the OTel root context. Request context is not inherited from the
listener's creation or a preceding MCP session initialization. HTTP command spans
are SERVER spans. Malformed trace headers are handled by the configured standard
propagator; they do not replace invocation identity.

An injected adapter's `run` receives `traceContext`, a string-valued W3C carrier
captured inside its adapter span. Project Markdown bindings can capture the same
carrier through `traceCarrier` and create application spans through the supplied
observability facade. The generic process helper forwards a supplied carrier in
`RUNDOWN_TRACE_CONTEXT`, a Rundown-specific JSON environment carrier distinct from
the standard `OTEL_*` exporter settings. Project bindings own how it is mapped
into a particular client's connection configuration or API requests.

The stdio/HTTP bridge forwards that inherited carrier even without a local
exporter/SDK. Scoped MCP exposure also supplies a `headers` field in its remote
configuration; adapters constructing MCP clients must pass those headers through.

Callback spans retain their registration's owning command as parent. Incoming
external span context is added as a span link rather than overriding that parent.
Logs and metrics remain attributed to the original invocation.

The observability entry exports `traceCarrier`, `withTraceContext`,
`environmentTraceContext` and `tracedFetch` for other adapters. `tracedFetch`
injects active context while preserving unrelated request headers and signals.
Extraction/instrumentation use the host's OTel providers and propagator. The
forwarded carrier is intentionally limited to W3C traceparent/tracestate.

## Author-facing observability

The invocation already supplies the logger, metric facade and observability
instance. Module methods do not construct these or initialize an SDK.

```js
context.log.info("Processing document", { path });
const completed = context.metrics.counter("documents.completed", {
  description: "Documents processed successfully",
  attributeKeys: ["kind"],
});
await context.observability.span("document.process", { path }, async () => {
  await processDocument(path);
  completed.add(1, { kind: "report" });
});
```

- `context.log.<level>(message, fields?)` returns void; levels are trace, debug,
  info, warn, error and fatal. Invocation and active trace correlation are automatic.
- `context.metrics.counter(name, options?)` returns an instrument with
  `add(value, attributes?)`. Values must be finite and nonnegative.
- `context.metrics.histogram(name, options?)` returns an instrument with
  `record(value, attributes?)`. Values must be finite.
- Metric options are `description`, `unit` and `attributeKeys`; defaults are empty.
  Attribute keys constrain external reporting, while local measurements use the
  standard metric API. Only explicit reporting aliases are externally exposed.
- `context.observability.span(name, fields, operation)` returns a Promise of the
  operation's value, awaits it, records failures and ends the span. Its parent is
  the active trace context. Commands, callbacks and binding runs already have spans.

See `rundown --reference observability` for the agent-readable contract. SDK/exporter
initialization belongs to the host; ordinary command CLI execution handles its
configured SDK lifecycle. Logging goes to stderr.

## Testing

See [Testing Rundown programs](testing.md) and `rundown --reference testing`.
`@p10i/rundown/testing` exports `createTestRuntime(t, options?)`, returning a real
Runtime and attaching its shutdown to Node's `t.after`. Options are normal Runtime
options plus an optional `entry` catalog path/URL. Relative entry paths resolve
against cwd, which defaults to the test worker's working directory.
