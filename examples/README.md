# Executable examples

Run these from the package checkout after `npm ci`. The examples also ship in the
package and are exercised through installed-artifact tests.

Each example is a separate package with explicit Rundown entry points. The source
checkout uses npm workspaces and `file:../..` runtime dependencies; `npm ci` links
them to the local implementation. When copying an example into a standalone
project, replace that local runtime dependency with the published version or your
chosen local tarball, then install its declared dependencies.

## 1. Command to module

```sh
node bin/rundown.mjs --cwd examples/greeting --check
node bin/rundown.mjs --cwd examples/greeting example Ada
```

Expected: `Hello, Ada!`. Read the Connections table, command handler and module
method/private helper in that order.

## 2. Application Markdown through do-md

```sh
node bin/rundown.mjs --cwd examples/document-processing --check
node bin/rundown.mjs --cwd examples/document-processing pending Target.md
```

Expected: `{"total":3,"completed":1,"pending":2}`. The input is unchanged.
The module uses the public do-md API and an adjacent application-document template.
Static checking resolves declared packages but does not evaluate the module or
open runtime-selected application input files.

## 3. Deterministic callbacks and reporting

```sh
node bin/rundown.mjs --cwd examples/callbacks --check
node bin/rundown.mjs --cwd examples/callbacks agent
```

Expected: a successful outcome with summary `Deterministic callback round trip
completed.` A fake harness uses real Streamable HTTP MCP to report logs, update a
declared metric and invoke completion. No provider is required.

## 4. Resumable non-AI pipeline

Copy [pipeline](pipeline/README.md) into a working project, then run `rundown build`.
The example generates work documents, executes a bounded native script, verifies
receipts and updates a Markdown plan. Its pause mode demonstrates safe recovery
from interruption between artifact creation and the parent completion marker.

## 5. Live Markdown views

```sh
node bin/rundown.mjs --cwd examples/views --check
node bin/rundown.mjs --cwd examples/views report
node bin/rundown.mjs --cwd examples/views --fullscreen --logs show report
node bin/rundown.mjs --cwd examples/views --json report
```

The command returns a live view and a module updates its state. Explicit close
completes the invocation. Interactive terminals re-render styled Markdown; pipes
receive final Markdown and `--json` receives final state. The do-md template also
receives display dimensions independently of state. See [views](../docs/views.md).

## Fresh-project exercise

Create a package, install Rundown, and copy the greeting's `commands.md`, `example/`
and `tests/` files into it. Register those existing paths and run:

```sh
rundown --init commands.md tests/
rundown example Ada
rundown --new-command hello
rundown hello "A custom message"
rundown --new-module hello/helper.md
rundown --check
rundown --check hello/helper.md
```

`--new-command` connects a catalog and creates a companion module so the command
works immediately. Its starter returns a message; it does not pretend to implement
an application-specific operation. Standalone modules are not implicitly imported.
