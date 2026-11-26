# Live Markdown views

A view is a live JSON document rendered through a do-md template. Pass it to
ordinary modules, update it explicitly, and return it from a command. The handler
return hands the view to Rundown; **explicit closure completes the run**.

## Create, track work, return and close

Inside a command handler:

```js
const worker = await rundown.loadModule("./worker.md");
const view = await rundown.createView("./report.md.template", {
  status: "Processing",
  completed: 0,
});
view.track(async () => {
  await worker.process(view, context);
  view.update({ status: "Completed" });
  view.close();
});
return view;
```

`rundown.createView` resolves the template relative to the declaring Markdown
document, just like the owner-bound loaders. Ordinary JavaScript can import
`createView`, `View` and `isView` from `@p10i/rundown/views`. Native relative paths
need `cwd` or `baseURL`; `new View(source, data, options?)` supports inline templates.

The [complete example](../examples/views/reports/commands.md) passes its view to a
[worker module](../examples/views/reports/worker.md). Run it from the package root:

```sh
node bin/rundown.mjs --cwd examples/views report
node bin/rundown.mjs --cwd examples/views --fullscreen --logs show report
node bin/rundown.mjs --cwd examples/views --json report
node bin/rundown.mjs --cwd examples/views --markdown report
```

## State and operations

| API                        | Contract                                                                      |
| -------------------------- | ----------------------------------------------------------------------------- |
| `view.data`                | A JSON snapshot, not a mutable reference to internal state.                   |
| `view.revision`            | Monotonic revision advanced by updates, configuration and termination.        |
| `view.update(patch)`       | Shallow merge of top-level fields. Nested objects are replaced.               |
| `view.replace(data)`       | Replace the whole state object.                                               |
| `view.track(operation)`    | Observe a promise, or start a function in a microtask and observe its result. |
| `view.close()`             | Seal updates and complete successfully; repeated closure is harmless.         |
| `view.fail(error)`         | Seal updates and fail the invocation.                                         |
| `view.done`                | Resolves on close; rejects on failure or invocation cancellation.             |
| `view.render(display?)`    | Synchronously render the current snapshot as Markdown.                        |
| `view.subscribe(listener)` | Subscribe to invalidation; returns an unsubscribe function.                   |
| `view.configure(options)`  | Change terminal presentation while the view is open.                          |

State must be an object containing JSON values: finite numbers, strings, booleans,
null, arrays and plain objects. Functions, undefined, class instances and cycles
are rejected. Input and output snapshots prevent hidden mutations; update calls
are the notification boundary. Reads and rendering remain available after closure;
updates, replacement, configuration and new tracked operations are rejected.

Attach ongoing work before returning the view. Rejections are observed even if
they occur before the handler returns. Successful work does not close the view:
some operation must explicitly call `close()`, or the invocation remains open.
Function-form tracking avoids starting an operation before it is attached.

A view created or tracked inside an invocation is owned immediately, before the
handler returns. Handler failures cancel its work through the invocation signal and
drain owned views within the cleanup grace. Open views that are not returned are
cancelled when the invocation ends. Returning controls display and waiting, not
the start of resource ownership. Views created outside an invocation stay caller-owned
until tracked or returned inside one. Do not keep invocation-owned views in shared
module globals.

A returned open view keeps the invocation and Node event loop alive, including
its callbacks, cancellation signal and execution capabilities. Cancellation signals
work through `context.signal` and ends the wait. On closure, pending attached work
and callbacks drain within the invocation's cleanup grace (`--grace-ms`, default
5000 ms). Errors after closure are reported during cleanup; unfinished work fails
with `RUNDOWN_CLEANUP_TIMEOUT`. Arbitrary JavaScript cannot be forcibly stopped.

Do not close in `finally` to hide an operation failure. Attach the operation and
let rejection fail the view. Likewise, application data such as `{status:'failed'}`
does not itself change the command exit status: call `fail(error)` or throw from
tracked work. Do not await closure as the mechanism that is supposed to close it.

Registrations created directly with `context.callbacks.register` retain invocation
ownership while a returned view is open. A lexical `callbacks.with` scope still
ends when its operation returns; put that scope inside tracked work when it must
remain active during the live operation.

## do-md templates

Templates are normal trusted do-md `.md.template` assets, not executable module
documents and not Connections. They receive:

```js
{
  data: { status: "Processing", completed: 5 },
  display: { width: 100, height: 30 }
}
```

do-md names that context `ctx`. Literal Markdown and its synchronous JavaScript
blocks compose normally:

```text
# Processing report

{% doc.write(ctx.data.status); %}

Processed **{% doc.write(ctx.data.completed); %}** items.
```

Use do-md's own Skill/reference for its full template and Writer API. Rendering
provides no invocation context or IO adapter. Keep business rules and external
effects in modules; templates arrange data into Markdown. Templates are trusted
JavaScript, not a sandbox.

`view.render({width, height})` produces Markdown, without ANSI styling or cursor
control. Dimensions default to 80 by 24, must be positive integers up to 10000, and
are separate from application data. Each consumer can choose its own dimensions.
Terminal resize re-renders without changing state or revision.

`--check` follows literal owner-bound `rundown.createView` targets and compiles
templates without executing them. Direct template checks are supported too.
Computed or shadowed targets are reported as dynamic. Actual rendering is still
needed to verify data-dependent behavior.

## Terminal hosting

The CLI mounts a view when the handler returns it. Changes made before returning
become its initial snapshot. An already-closed view displays its final state and
finishes immediately. Rapid updates coalesce into rendering the latest revision.

Creation options and `view.configure` accept:

```js
{ fullscreen: false, logs: "show" }
```

Normal mode defaults to showing logs. Full-screen creation defaults to hiding
them unless `logs` is supplied explicitly. CLI `--fullscreen`, `--no-fullscreen`
and `--logs show|hide` override the view's settings.

- **Inline, logs shown:** output appends above the redrawable view in scrollback.
- **Inline, logs hidden:** mounted terminal output is suppressed.
- **Full-screen, logs hidden:** the view occupies the alternate terminal screen.
- **Full-screen, logs shown:** a bounded recent-log region appears above the view.

The host supports common Markdown headings, emphasis, code, lists, links, quotes
and tables, with terminal-width and Unicode-aware wrapping. Live content is clipped
to the available screen; final output is not height-clipped. `NO_COLOR` disables
color and `TERM=dumb` disables live terminal controls. Full-screen mode restores
the original screen/cursor and leaves the final report in normal scrollback.
This is a live document display, not a keyboard/widget framework.

Terminal dimensions are total columns/rows; the host reserves rows as necessary
for logs and cursor control. Use `display` for responsive document structure, while
the host performs final clipping/wrapping.

Structured logs and direct JavaScript console/stream writes pass through the CLI
host while a view is mounted. Hiding terminal output does not disable telemetry
exporters or custom logging sinks. Inherited subprocess file descriptors bypass
JavaScript routing; use captured process output and explicit logging for those
operations. Do not install another full-screen terminal owner simultaneously.

## Final output and other surfaces

| Surface                       | Returned view output                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| Interactive CLI               | Styled, live Markdown; final report on close.                       |
| Redirected/noninteractive CLI | Final raw Markdown, with no terminal controls.                      |
| `--json`                      | Final JSON state, without view internals.                           |
| `--markdown`                  | Final raw Markdown, even in a terminal.                             |
| Default HTTP                  | Existing `{ok:true,result}` envelope containing final JSON state.   |
| HTTP `Accept: text/markdown`  | Final Markdown with `text/markdown` content type.                   |
| MCP                           | Final Markdown text plus `{result: finalState}` structured content. |

JSON and explicit Markdown CLI modes route direct JavaScript stdout to stderr so
stdout contains only the final result. Ordinary non-view values remain strings or
JSON; undefined emits no normal result output (`--json` emits null).

HTTP requests may supply `?width=100&height=30` with Markdown output. They wait for
closure, and disconnecting cancels the invocation. Rendering dimensions are
validated before executing the command. There is no retained live-resource index
or streaming endpoint in this version. Consumers can render a current snapshot
through the library's `view.render` API.
Accept negotiation respects quality, explicit q=0 exclusions and wildcard
specificity. Unsupported representations return 406 before executing the command.
On equal quality an explicitly accepted Markdown representation is preferred;
an unconstrained request defaults to JSON. Terminal finalization errors are added
as related diagnostics when execution has already failed.

Library `Runtime.invoke` returns the closed View after cleanup. Its optional
`onView(view)` callback lets an embedding host attach when the handler returns,
before closure. An embedding host owns its subscription and display lifecycle.

## Testing

Test snapshots and template output independently from terminal hosting:

```js
const view = await rundown.createView("./report.md.template", {
  status: "Ready",
  completed: 2,
});
assert.match(view.render({ width: 40 }), /Ready/);
view.update({ completed: 3 });
assert.equal(view.data.completed, 3);
view.close();
```

Command tests use the real Runtime, as usual. They must eventually close or cancel
a returned live view. Terminal tests cover output routing and restoration, with a
real POSIX pseudo-terminal exercise where Python's standard `pty` module exists.
