# Authoring a Rundown project

With the package installed and `rundown` on PATH, start in an existing project
directory. For a local npm installation, prefix the commands below with `npx`.
The package also exposes the equivalent `rndn` executable.

## First run

Create a JavaScript package and install Rundown through npm. Write your catalogs
and modules, or copy the shipped greeting's source files and tests, before registering
their locations. The following commands assume that greeting's files already exist:

```sh
rundown
rundown --init commands.md tests/
rundown example Ada
rundown --check
```

The first invocation explains how to begin when no catalog is registered. Registration
updates only the nearest package.json; the example source layout is:

```text
package.json
commands.md
example/
  commands.md
  module.md
tests/
  greeting.test.md
```

The command registers `rundown.commands` and `rundown.tests`. Their paths resolve
from the package directory; source layout is otherwise unrestricted. Discovery
stops at the nearest package, even when it has no Rundown declarations. Use
`--commands path/to/catalog.md` to select an explicit catalog. No hidden-directory
fallback exists. Read the [project contract](projects.md) for details.

The root's Connections table imports command
definitions; the command handler loads a module; the module's Markdown generates
its method declaration. No compiler templates or provider config are copied into
the project. `--cwd <directory>` selects an existing location without changing the
process working directory.

## Add a command

```sh
rundown --new-command hello
rundown hello
rundown hello "A custom message"
rundown help hello
```

This creates `hello/commands.md` and its companion `module.md` beside the selected
catalog, then adds a Connections row there. The starter returns a message; it is
working scaffolding, not a claim to implement a domain-specific operation.
Change its description, parameter/return tables and method body together.

Choose an exact output directory when that convention does not fit:

```sh
rundown --new-command hello --out tools/greetings
```

This creates `tools/greetings/commands.md` and `tools/greetings/module.md` relative
to --cwd and connects them to the selected catalog. --out does not append the
command name. Existing files remain conflicts. Catalogs may have arbitrary .md
filenames, including empty catalogs before their first generated command.
Packaged catalogs are read sources; select a local destination for authoring.

The root catalog is published last. Existing files and duplicate exposed command
names are conflicts, never overwritten. Connections changes use do-md's Editor
and revision-checked writes, preserving unrelated prose, examples and line endings.
Distinct concurrent scaffold operations merge the metadata with bounded CAS
retries; no command execution is retried. A partial failure preserves created files
and reports their paths rather than deleting possible user edits.

## Connect a copied catalog

```sh
rundown --connect copied/commands.md
rundown --connect npm:@example/recipes/commands
```

This validates the copied catalog and the proposed combined graph before changing
Connections. Duplicate names, cycles and module documents are rejected. Reconnecting
the same catalog is idempotent. It can also connect preserved files after a partial
scaffolding failure; it never regenerates the imported documents. Combined-graph
validation uses an in-memory source override, not a temporary edit to the real root.
Package connections retain their npm: export reference, keeping manifests/catalogs
portable across dependency installation layouts.

## Add a module

```sh
rundown --new-module hello/helper.md
rundown --check hello/helper.md
```

A standalone module has a documented async `run` method returning null. It is not
automatically imported or exposed as a command. Declare a Markdown dependency or
call `rundown.loadModule` from an implementation when the module is needed.

Starter generation uses do-md Writer templates from the package. These are
different from the universal `module.md.template` parser and the command parser.
Projects continue to use one universal module format.

## Read the Skill and reference

```sh
rundown --skill
rundown --reference
rundown --reference modules
rundown --reference commands --format json
```

`--skill` prints the authoritative packaged `skills/rundown/SKILL.md`; it does not
install agent configuration. Reference topics include projects, commands, modules,
context, callbacks, observability, testing, views, surfaces and debugging. Column/option definitions are shared with the
compiler and scaffold generators. The complete [reference](reference.md) is generated
from the same registry; `npm run docs:check` detects drift.

Main MCP endpoints expose these documents as resources:

- `rundown://skills/rundown`
- `rundown://reference` and `rundown://reference.json`
- `rundown://reference/modules` and the other topic names

The remote stdio bridge forwards resource discovery/reads as well as tools.
Callback-scoped endpoints retain their callback/reporting-only surface.

## Validate without running

```sh
rundown --check
rundown --check hello/helper.md
rundown --check --json
```

Default checking starts at the manifest-declared or explicit catalog. It compiles command definitions,
Connections and reachable Markdown modules, validates schemas/defaults, resolves
native imports, and follows literal owner-bound `loadModule` / `loadCommands`
calls. It never imports user JavaScript, installs ESM hooks or executes handlers,
method bodies, examples or native dependency initialization code.

Connected catalogs share a command namespace. A catalog loaded only inside a
handler is checked separately and does not become a root-exposed command. Native
ESM module cycles are allowed; Connections cycles and duplicate names within a
catalog collection are errors.

Only statically identifiable loader calls can be followed. Computed paths and
shadowed loader bindings produce explicit runtime-verification notes, not errors
or false guarantees. Native import resolution does not prove successful module
initialization. Application input files, provider access, runtime branch behavior
and arbitrary do-md asset selection require execution-specific verification.
Unreferenced standalone modules should be checked explicitly; prompts and other
Markdown data are not assumed to be Rundown modules.

`--json` returns the checker summary and structured diagnostics on stdout with a
nonzero exit code on failure. Human output includes source frames on stderr.

## Built-in flags and project names

Built-ins use flags so names such as `init`, `skill` or `check` remain available
for project commands. The existing `help` entry describes a project command.
Use `--cwd` to select the path-resolution/discovery starting directory. `--init`
requires an existing catalog path, not a preset name. Its optional second argument
registers a test directory or file. It creates no source or package metadata beyond
the supplied Rundown entry declarations.

Long-running hosts still require a restart to load changed definitions/modules,
including newly generated commands. CLI invocations naturally start fresh.
