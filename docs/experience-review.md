# First authoring experience review

## What the current workflow now covers

After creating a package and writing/copying the greeting files, the tested loop is:

```sh
rundown --init commands.md tests/
rundown example Ada
rundown --new-command hello
rundown hello "A custom message"
rundown --new-module hello/helper.md
rundown --check
rundown --check hello/helper.md
```

A new directory has useful help, Skill and reference before it has a catalog.
Initialization registers existing paths without generating a starter. Command scaffolding connects its
definition automatically and creates the module its handler calls. Static checking
is separate from execution, while dynamic references are explicitly identified.
Existing files and unrelated catalog regions are preserved.

## Remaining experience questions

### Real recipes before a starter registry

The current command starter returns a message. It establishes the format and
wiring, but the author still writes the actual application behavior. A real todo
recipe should be built with these tools next. The proposed todo, harness and
completion names need concrete contents to show which components genuinely recur.

Reusable recipes can be sets of user-owned project documents with explicit
dependencies and Connections, using the existing universal module grammar.
Recipe copying/installation is separate from --init's manifest-registration role.
Composition into an existing project would matter more than generating another
entire project skeleton. Existing user files must remain conflicts, not targets
for automatic replacement.

### Copy/paste needs a connection step

Copying a custom recipe is reasonable. The connection operation is now implemented
as `--connect`: it uses the revision-safe Connections editor, validates the proposed
graph, and makes copied or partially created catalogs discoverable. This closes
that manual step without requiring a global starter registry.

### Custom starter folders need a concrete use case

A home-directory collection would introduce naming, version expectations and
collision handling. There is no evidence yet that automatic global discovery is
needed. If personal collections become common, an explicit starter source directory
would be easier to understand than an implicit search path. Starter folders must
remain distinct from do-md application templates and Rundown's parser templates.

### Improve reference presentation through usage

The reference has a canonical registry and complete machine-readable definitions.
Human output can become more example-driven as real recipes expose recurring
questions. The format should stay shared with parsing and scaffolding, rather than
maintaining independently drifting tutorials and generators.

### Keep execution and authoring expectations clear

Static checks do not prove runtime behavior or provider availability. Unreferenced
modules need explicit checks, and long-running hosts need a restart after definition
changes. New-command output is a runnable starter rather than an implementation of
the chosen domain name. These distinctions should remain visible in guidance and
examples as the tooling grows.
