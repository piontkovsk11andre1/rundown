# Rundown

Documentation-first Markdown modules and commands, compiled through do-md into
native ESM. Node **22.15+** is required for programmatic synchronous ESM hooks.
This source prepares **2.0.0-rc.3**. Its canonical repository location is
the repository root; see the [changelog](CHANGELOG.md), [migration notes](docs/migration-2.md)
and [release procedure](docs/releasing.md).

## Run

```sh
npm ci
node bin/rundown.mjs --cwd examples/greeting example Ada
node bin/rundown.mjs --cwd examples/greeting help example
node bin/rundown.mjs --cwd examples/callbacks agent
node bin/rundown.mjs --cwd examples/greeting --test
node bin/rundown.mjs --cwd examples/callbacks --test
npm run check
```

The greeting returns `Hello, Ada!`. The callback example starts a temporary
loopback listener, uses a deterministic MCP client to report logs, update a
declared counter and deliver a completion callback, then closes everything.
It does not call an AI provider. Its deterministic client is an ordinary Markdown
module under `examples/callbacks/ai/harness`. Projects own any external
CLI or service integration they need.

After installation, `rundown` and `rndn` are equivalent executable names.

## Start a new project

Projects declare `rundown.commands` and optional `rundown.tests` in package.json.
Native imports use normal dependencies. See [packages and layouts](docs/projects.md)
or `rundown --reference projects`; no hidden-directory fallback is used.

Use npm to create the package and install dependencies. Write or copy a command
catalog, then register it. For a minimal empty catalog, create `commands.md`
containing `# Project commands` before running:

```sh
rundown --init commands.md
rundown --new-command hello
rundown hello "A custom message"
rundown --new-module hello/helper.md
rundown --check
rundown --check hello/helper.md
```

`--init` only registers existing paths in the nearest package.json. An optional
second argument registers tests: `rundown --init commands.md tests/`. A new command gets a connected
catalog and runnable companion module. Standalone modules are explicitly imported
when needed. Existing files are never overwritten.
Use `--new-command hello --out tools/greetings` for exact placement of the generated
catalog/module pair. Installed document assets use explicit `npm:package/export`
references; see [package exports](docs/projects.md#installed-document-exports).

```sh
rundown --skill
rundown --reference modules
rundown --reference commands --format json
```

Skill and reference work before a project exists; registration requires an existing
package and catalog. `--check`
validates reachable documents and static dependencies without evaluating user
code, and reports dynamic loads needing runtime verification. See the
[authoring guide](docs/authoring.md), [generated reference](docs/reference.md),
and [executable examples](examples/README.md).
The [first experience review](docs/experience-review.md) records the next choices
around reusable recipes and copied catalogs.

Copied recipes can be connected with `rundown --connect <commands.md>`; the
combined graph is validated before its Connections row is published. The
[resumable pipeline](examples/pipeline/README.md) demonstrates generation, a bounded
script, verified receipts and recovery after interruption without an AI dependency.

For ordinary scripts, `@p10i/rundown/process` exposes `runProcess` and
`ProcessAdapter`. Adapters have domain-specific input; common working-directory,
cancellation and tracing metadata are supplied by the invocation. Harness-specific
APIs, prompts and configuration are defined by users/agents in project Markdown
modules, with native JavaScript dependencies as needed.

Use `context.run(binding, input)` to supply those execution defaults to a project
Markdown binding directly. `context.callbacks.with` scopes registrations and
awaits cleanup. Read `rundown --reference context`, `callbacks` and `observability`
for the author-facing contracts.

## Test programs

Declare a test file/directory in `package.json` under `rundown.tests`. Public methods
are tests receiving Node's `t` and a managed Rundown context; assertions come from
`node:assert/strict`. `rundown --test` executes them in isolated Node workers.
`@p10i/rundown/testing` supplies a managed real Runtime for command tests.
See the [testing guide](docs/testing.md) or `rundown --reference testing`.

## Live Markdown views

Commands can return a live JSON document presented through a do-md template:

```js
const view = await rundown.createView("./report.md.template", {
  status: "Working",
});
view.track(async () => {
  await worker.run(view, context);
  view.update({ status: "Completed" });
  view.close();
});
return view;
```

Return mounts the view; explicit close completes the invocation. Terminal output
re-renders on updates/resize, optionally in full-screen mode with shown/hidden
logs. JSON, HTTP and MCP receive the final state or final Markdown. Templates use
`ctx.data` and `ctx.display`, keeping terminal dimensions separate from data.

```sh
node bin/rundown.mjs --cwd examples/views report
node bin/rundown.mjs --cwd examples/views --fullscreen --logs show report
node bin/rundown.mjs --cwd examples/views --json report
node bin/rundown.mjs --cwd examples/views --markdown report
```

See [live views](docs/views.md), the [example](examples/views/reports/commands.md)
and `rundown --reference views` for lifetime, rendering and output contracts.

## Surfaces

```sh
rundown --cwd /project example Ada
rundown --cwd /project --serve --port 4080
rundown --cwd /project --mcp
rundown --mcp-http http://127.0.0.1:4080/mcp
```

Rundown options precede the project command. Subsequent arguments belong to the
command. Surface modes are mutually exclusive. `--mcp-http` is a stdio-to-remote
Streamable HTTP bridge, not the deprecated HTTP+SSE transport.

`--serve` exposes HTTP and Streamable HTTP MCP together. Its default bind is
loopback and default port is automatically assigned. `--bind`, `--port`, and
`--public-url` configure exposure. `--grace-ms` sets the cleanup deadline.
Public URL prefixes require an outer proxy
to strip the prefix before forwarding. Embedders can configure allowed browser
Origins through `startHttp`; unsolicited browser Origins are rejected by default.

## Modules and commands

Start with [the greeting manifest](examples/greeting/package.json), its
[catalog](examples/greeting/commands.md), [command definition](examples/greeting/example/commands.md),
and [module](examples/greeting/example/module.md).

The core loaders are `loadCommands` and `loadModule`. Supporting exports provide
compilation and host integration rather than another orchestration language.

The format is defined by separate [command](templates/commands.md.template) and
[module](templates/module.md.template) do-md templates. They compose scoped
bindings, optional sections and required fields; JavaScript generation consumes
those bindings rather than scanning document blocks for executable code.

```js
import { loadCommands, Runtime } from "@p10i/rundown";

const cwd = "/absolute/project";
const catalog = await loadCommands(undefined, { cwd });
const runtime = new Runtime(catalog, { cwd });
try {
  console.log(await runtime.invoke("example", { name: "Ada" }));
} finally {
  await runtime.close();
}
```

Command discovery stops at the nearest `package.json` and uses `rundown.commands`.
Manifest paths resolve from that package; `--commands <catalog.md>` overrides discovery.
There is no hidden-directory fallback and no required source layout. Connections
load additional command definitions explicitly. Markdown dependency paths are
document-relative or absolute; there is no implicit module search path.

Markdown modules are real ESM modules: native static dependency imports, live
bindings, circular imports and canonical file-URL caching. File changes require
a process restart. JavaScript dependencies retain native resolution. Loading
defines methods and constants; it does not execute method bodies or examples.

The Node hook is installed once on the first load and recognizes `.md` imports.
Its scope is the Node runtime, not an individual invocation. Source files must
exist on the local filesystem; do-md IO adapters remain available to method code
for processing application documents.

## Debugging

```sh
rundown --compile /project/example/module.md --out ./compiled
rundown --debug-dir ./compiled --cwd /project example Ada
```

Normal compilation stays in memory. Artifacts use a document name plus URL hash
to avoid collisions. Maps include original source content. Compile-only reads
only its explicit target and does not evaluate dependencies or handlers. Output
still relies on Rundown's loader/runtime; it is not a standalone distribution.
`RUNDOWN_DEBUG_DIR` enables artifact output for transitively loaded documents.

## Observability

- `RUNDOWN_LOG_FORMAT=human|json` controls console output; terminal detection is
  the default. Logs go to stderr, leaving stdout for results or MCP messages.
- `RUNDOWN_LOG_LEVEL=trace|debug|info|warn|error|fatal` defaults to `info`.
- Standard `OTEL_*` exporter configuration enables the CLI-owned Node SDK.
  Embedders may initialize their own providers or call `initializeTelemetry`.
- Invocations, callbacks and injected adapter runs have spans. Logs carry an
  invocation ID and active trace/span identity. Metrics do not add invocation IDs
  as labels. OTel providers determine exemplar support.
- HTTP extracts W3C context per request. External runs receive a `traceContext`
  carrier; project bindings forward it to remote clients, and the generic process
  helper supplies the child-process `RUNDOWN_TRACE_CONTEXT` JSON environment
  variable. The remote bridge forwards
  inherited context as well. Callback spans keep their owning command as parent
  and link external callers, preserving invocation correlation.

External reporting is explicitly enabled on a callback registration. Only exposed
counter/histogram instruments and allowed attributes can be updated. Correlation
fields are attached by Rundown and cannot be replaced by external reports.

Cleanup expiry is explicit: unfinished callbacks are revoked and a
`RUNDOWN_CLEANUP_TIMEOUT` diagnostic is returned. Primary errors are preserved,
with secondary cleanup errors in `related`. Internal JavaScript is now checked
with strict `checkJs`, independently of the public declaration consumer checks.

See [format](docs/format.md), [invoking an ACP agent](docs/acp.md), [API and lifecycle](docs/api.md), and
[verification](docs/verification.md) for the detailed contracts.
