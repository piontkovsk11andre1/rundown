# Packages, discovery and source layout

Rundown projects are JavaScript packages with explicit document entry points.
Source files can use any directory structure. The package manifest combines native
dependency declarations with Rundown configuration:

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@p10i/rundown": "2.0.0-rc.3"
  },
  "rundown": {
    "commands": "./automation/commands.md",
    "tests": "./specs"
  }
}
```

## Package boundary

Starting from `--cwd` (or the process working directory), discovery stops at the
nearest `package.json`. It never skips an unconfigured child package to inherit
Rundown entries from an ancestor. Invalid JSON, invalid Rundown configuration and
unreadable manifests are errors, not reasons to keep searching.

`rundown` must be an object. `commands` and `tests`, when present, must be nonempty
path strings. Each is needed only by operations that use it: a tests-only package
is valid, and explicit document operations need neither declaration.

There is **no `.rundown/commands.md` or hidden-test-directory fallback**. Dot
directories have no special source-loading meaning. Projects may use `.rundown`
for their own caches, artifacts or other application-owned data; the engine does
not infer source/configuration from it.

## Selection and paths

```sh
rundown release
rundown --commands ./tools/commands.md release
rundown --commands ./tools/commands.md help release
rundown --commands ./tools/commands.md --check
rundown --commands ./tools/commands.md --serve
rundown --commands ./tools/commands.md --mcp
rundown --test ./specs
```

Explicit `--commands` selects the root catalog for execution, command help,
HTTP/MCP hosting, default checks, new commands and catalog connection. Without it,
those operations use the nearest package's `rundown.commands`. Connections compose
additional catalogs explicitly; discovery does not combine ancestor catalogs.

| Path                                             | Resolution base                                         |
| ------------------------------------------------ | ------------------------------------------------------- |
| Manifest `rundown.commands`, `rundown.tests`     | Containing manifest directory                           |
| Explicit CLI catalog/module/test paths           | Invocation `--cwd`                                      |
| Application path arguments                       | Invocation `--cwd`                                      |
| Connections, module dependencies, view templates | Declaring document                                      |
| Native package imports                           | Standard Node ESM resolution from the original document |

Discovery never changes the working directory. Running from a nested directory
may discover its package's catalog, while `Input.md` still refers to that nested
execution directory. Library calls retain the same rules: `loadCommands(entry,
{cwd})` selects explicitly; omitting entry uses package discovery. `loadModule`
and `createView` retain explicit/document-relative loading.

`--check file`, `--test path`, `--compile file`, `--new-module file`, Skill and
reference operations do not require a configured catalog. Standard native package
rules still apply to JavaScript imports.

## Initialization and authoring

```sh
rndn --init automation/commands.md tests/
```

Registration uses the nearest existing package.json, following the normal package
boundary rules. Both arguments resolve from --cwd. The catalog is statically checked
without executing handlers or native imports; a module or view is not a catalog.
The optional test target must be an existing directory or .test.md file. Empty test
directories are valid registrations, but test execution still fails when no cases exist.

Only explicitly supplied entries are updated. Omitting the test argument preserves
its current declaration. Different paths reconfigure defaults; equivalent paths
are byte-preserving no-ops. Paths are stored relative to the manifest directory
with portable separators; different-drive Windows targets retain an absolute path.
Additional Rundown settings, scripts, dependencies and unrelated fields are preserved.

The operation generates no source files, dependency declarations, npm scripts,
lockfiles or package manifests. Create packages/install dependencies with npm and
write or copy source files independently. Bare --init prints usage. --commands is
temporary selection and cannot be combined with registration.

Manifest updates use revision-checked atomic publication. Concurrent edits produce
a conflict rather than overwriting newer metadata. Indentation and line-ending
conventions are retained. Native authoring code can call
`initProject(catalog, {cwd, tests?, signal?})`; it returns no created files and lists
the manifest in updated only when its configuration changes.

`--new-command name` creates a catalog/module pair in `name/` beside the selected
catalog and connects it there. `--connect` updates that selected catalog too.
`--new-command name --out directory` instead creates `commands.md` and `module.md`
in that exact directory, resolved from --cwd. It does not append the command name.
`--new-module path.md` always uses the requested path. These are authoring defaults,
not source-layout requirements.

Empty catalogs are valid under any .md filename. Registration and connection use
their explicit catalog context rather than guessing from the filename; documents
declaring module methods cannot be used as catalogs.

## Installed document exports

Use explicit package references for installed source assets:

```text
npm:@example/recipes/commands
npm:@example/recipes/report-template
```

The part after npm: is resolved through the package's normal exports map, from the
declaring document or invocation cwd. Private/unexported subpaths remain unavailable.
No package code is executed to resolve an asset. Loading a module still evaluates
its normal declared dependencies, as with local modules.

This syntax works with catalog selection, Connections, Markdown Dependencies,
loadModule/loadCommands, view templates, test selection and manifest entries.
JavaScript dependencies use their usual native specifiers without npm:. Local
paths retain their original meaning; there is no filesystem/package-name guessing.
Source aliases retain canonical real-file ESM identity and normal caching.

Registering or connecting a packaged catalog preserves the npm: reference rather
than persisting its current node_modules layout. Generated commands and Connections
edits target local catalogs; connect package catalogs into a local entry instead of
editing dependency sources.

## Native dependencies and examples

Declare packages imported by Markdown modules in the normal dependencies section.
There is no Rundown package installer or parallel dependency graph. Application
Dependencies tables describe actual imports, and the package manager installs them.

Each shipped example has its own manifest and package boundary. Layouts include
root catalogs, `tools/`, `automation/` and `reports/`. The source repository uses
npm workspaces with local `file:../..` runtime dependencies to exercise real native
resolution. A copied example should replace that source-checkout link with the
chosen published version/local tarball and install its declared dependencies.
