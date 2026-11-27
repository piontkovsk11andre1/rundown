---
name: rundown
description: Make Markdown programmable with Rundown. Author, validate and run documented commands and modules for deployment configuration, pipelines, document processing, and script or AI orchestration.
compatibility: Node.js 22.15 or newer with @p10i/rundown installed; application Markdown processing uses the public @p10i/do-md API.
---

# Working with Rundown

Rundown makes Markdown programmable: readable documents define commands and
modules that compile into native JavaScript modules. Markdown supplies the
structure, declarations and explanation; designated JavaScript method bodies
implement behavior. Ordinary prose and usage examples remain documentation.

Use this Skill to build and maintain programs around documents: infrastructure-as-code
and deployment configuration, build or data pipelines, large-scale document
analysis, administrative tools, or orchestration combining scripts, services and
AI. Choose the application model that fits the task; an AI harness is one possible
integration, not a required execution model.

To invoke a local ACP agent, use `invokeAcp(context, connection, input)` from
`@p10i/rundown/acp`. Supply invocation-local MCP tools and designate a terminal
callback; check `result.status` before using its value. Session text is not a
callback result. See [ACP invocation](../../docs/acp.md) for launch settings,
resume, recording and cancellation.

## Think in programmable documents

Distinguish the roles of the files you author:

- **Command catalogs** expose entry points and connect other command definitions.
- **Module documents** define reusable behavior and dependencies.
- **Application templates** define how to read or generate structured Markdown
  through do-md, independently of Rundown's module grammar.
- **Application documents** carry configuration, input, generated work, findings,
  results or persistent state according to the application's schema.
- **Views** are do-md templates presenting live JSON state as Markdown. Returning a
  view keeps a command active until explicit close, failure or cancellation.

Compose these capabilities to read and validate inputs, select operations,
generate or update documents, call module methods, invoke scripts or external
services, and collect results. Generated Markdown can become input to another
stage or be compiled as a Rundown module when executable definitions are needed.
The project's logic can live in Markdown modules and templates while using normal
JavaScript package dependencies.

Start from the intended behavior and document contracts, then choose commands,
modules and data formats to express it. Keep related explanation and implementation
together. Use ordinary JavaScript control flow rather than inventing an additional
workflow language inside the document.

When repeatability or resumption matters, define durable state, completion and
recovery rules in the application. Re-read changing documents explicitly; process
memory and live callbacks are not persistent checkpoints. Execution and external
effects are not automatically transactional.

## Start with the project

Read `rundown --reference projects`. Manifest entry paths resolve from package.json;
explicit CLI paths and application arguments resolve from --cwd. Stop at the nearest
package boundary even when it has no Rundown entries. Use `--commands <catalog.md>`
to select an independent catalog. Keep JavaScript dependencies in the package manager.

1. Read the nearest `package.json`, its `rundown` entries and catalog Connections
   before creating files. Source layout is unrestricted; no hidden-directory fallback exists.
2. Run `rundown` or `rundown help <name>` to discover existing project commands.
3. Create packages and install dependencies with npm. Write or copy source files,
   then register them with `rundown --init commands.md tests/` (tests optional).
   This updates only the nearest manifest; it does not generate a greeting or
   declare dependencies. Use --cwd for path resolution; equivalent registrations
   are no-ops and omitted test entries are preserved.
4. Read `rundown --reference commands` and `rundown --reference modules` for the
   exact grammar. `--format json` supplies structured definitions.

## Author documentation, then implementation

- `rundown --new-command hello` creates a connected command catalog and companion
  module. The starter command returns a message; replace its documented behavior
  and implementation together.
- Add `--out tools/hello` to choose an exact directory relative to --cwd; it
  contains commands.md and module.md without another command-name directory.
- `rundown --new-module hello/helper.md` creates a standalone module.
  Connect it through a Dependencies table or a method's `loadModule` call.
- For a copied recipe, run `rundown --connect path/to/commands.md` to validate and
  connect its catalog without regenerating its files.
- Preserve existing files. Generators refuse conflicts. If a multi-file operation
  reports partial creation, inspect the listed files before reconnecting them.
- Connections tables import command definitions, not modules. Dependencies tables
  import module namespaces or native JavaScript namespaces.
- Keep parameter names, types, defaults and results in Markdown tables. Place only
  a function body in Handler or Implementation; the compiler supplies declarations.
- Methods default to public and async. Mark private/sync helpers in Options.
- Keep explanatory prose, lists, diagrams and usage examples in the document.
  Examples are documentation and never enter the executable module.
- There is one universal module grammar. Use do-md directly for other document
  formats rather than introducing per-project Rundown compiler templates.

## Check before running

```sh
rundown --check
rundown --check hello/helper.md
rundown --check --json
```

Check compiles documents and resolves static dependencies without evaluating user
JavaScript or running handlers. It reports unresolved dynamic loader expressions.
It does not verify external-service availability or runtime-only behavior.

After checking, invoke the intended project command. Positional names come from
the project's catalogs; built-in authoring operations use flags.

## Test behavior

Read `rundown --reference testing`. Declare a test file/directory through
`rundown.tests` in package.json; run `rundown --test` or an explicit test file/directory.
Every public method is a test and private methods are helpers. Test arguments are
positional `(t, context)`: Node's real TestContext and a managed Rundown invocation.
Use `node:assert/strict`, normal Dependencies and document-relative loaders.
`@p10i/rundown/testing` provides `createTestRuntime(t, options?)` for invoking real
commands with validation and automatic shutdown. Files are isolated processes;
ESM state is shared within each file. Failures, cleanup errors and no tests exit
nonzero; `--json` provides structured results. Tests execute code; --check does not.

## Use the library explicitly

Module methods are ordinary ESM functions. Pass invocation context as a documented
parameter when needed. Dependencies load with the module and share native ESM
cache identity; invocation-specific data belongs in parameters and local variables.

For ordinary scripts, the public `@p10i/rundown/process` entry provides bounded
execution and a ProcessAdapter. Custom adapters accept application-specific input;
the invocation supplies working-directory, cancellation and tracing metadata.
Use `context.run(binding, input)` for project Markdown/native bindings exposing
`run(input)`; it supplies the same defaults, cancellation and tracing without
adapter bootstrapping. Await it and honor the supplied signal in the binding.
Passing context.adapters bindings through context.run does not add a duplicate
span. Bound capabilities belong to their invocation; reuse raw adapters, not wrappers.
Prompt fields belong to an AI adapter, not the common execution model.
Define harness bindings as ordinary project-level Markdown modules. They can use
native JavaScript packages, generic process execution or HTTP to integrate an
external CLI or service. The project owns configuration,
request/response formats and completion policy; Rundown supplies the reusable
execution, callback and observability capabilities.

Use do-md templates and public APIs to parse or edit application Markdown. Read
do-md's own Skill/reference for its template language; Rundown's module grammar
and do-md's application document templates are distinct concerns.

Use explicit `npm:package/export` references for installed catalogs, Markdown
modules, view templates and tests. They resolve via package exports from the owner
document or cwd; ordinary paths retain filesystem semantics. JavaScript Dependencies
use native specifiers without npm:. Connect packaged catalogs into local entries
instead of authoring into dependencies. Empty catalogs need no special filename.

## Callbacks and external runs

Read `rundown --reference callbacks` and the packaged callback example first.

- Define callbacks in JavaScript with descriptions, object JSON schemas and handlers.
- Register before starting the external caller, then supply its scoped connection
  details and schemas to the script, service or harness. MCP callers receive tool
  definitions and configuration; forward supplied HTTP headers.
- Prefer `context.callbacks.with(definitions, [options], operation)` for a scoped
  lifetime; it returns the operation's result after callbacks drain. Check final
  application outcomes after that scope. Use register plus try/finally for explicit
  lifetimes. Their fallback owner is the command
  invocation, not the module method that created them.
- Calls serialize within a registration. Never await closing a registration from
  inside one of its own handlers.
- Propagate `context.signal` to external operations. Cancellation cannot undo
  effects already committed.
- The application decides what completion means. Verify required reports, process
  outcomes and application results as appropriate. For AI integrations, free-form
  agent text alone is not a verified outcome.
- Expose logs and explicitly declared metric instruments through reporting options.
  Do not invent arbitrary metric names or override correlation fields.

## Use existing observability

Read `rundown --reference context`, `callbacks` and `observability` for signatures,
defaults and lifetime guarantees. Use `context.log.info(message, fields?)`,
`context.metrics.counter(name, options?).add(value, attributes?)` and
`context.metrics.histogram(name, options?).record(value, attributes?)` directly.
Use `context.observability.span(name, fields, operation)` for application spans;
commands, callbacks and `context.run` are instrumented already. Do not construct
loggers or initialize an OTel SDK in module methods. Bindings own client-specific
trace-header/configuration mapping; common invocation mechanics belong to Rundown.

## Present live views

Read `rundown --reference views`. Use `await rundown.createView(template, data,
options?)` for document-relative templates; native JavaScript can use
`@p10i/rundown/views`. Pass the view explicitly into modules, use `update` for a
shallow merge or `replace` for whole state, and attach continuing work with
`view.track(() => worker.run(view, context))`. Return the view from the handler.
Successful tracked work does not close it: explicitly call `close()` after success,
or let a tracked rejection fail it. Do not detach unobserved background work.
Views created/tracked inside an invocation acquire ownership before return. Failures
abort their owning invocation even before handoff, and unreturned open views cancel
at invocation completion. Returning selects presentation, not resource ownership.

Templates receive `ctx.data` and `ctx.display` (`width`, `height`) and use public
do-md Writer/template APIs. Keep workflow logic in modules. Snapshots are JSON-only;
mutating a getter result does not update state. Rendering and terminal resize do
not mutate state. `render(display?)` is surface-neutral Markdown.

Interactive CLI output re-renders, optionally using `--fullscreen` and `--logs
show|hide`. Logs/console writes are coordinated while mounted; inherited child fds
must be captured separately. `--json` returns final state; `--markdown` returns final
Markdown. HTTP/MCP await closure. Use Node assertions to test view state and rendered
Markdown; `--check` compiles literal view templates without executing them.

## Diagnose failures

Use original Markdown locations in diagnostics. `--compile <module.md> --out <dir>`
produces inspectable JavaScript/maps without execution. `--debug-dir <dir>` records
runtime artifacts. Use `--json-errors` for structured invocation failures.

Root scoping, cancellation and logging belong to their documented layers. Keep
application-specific state transitions, retries and recovery policies explicit in
module methods and document schemas.
