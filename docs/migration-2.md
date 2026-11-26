# Moving to Rundown 2

This candidate establishes a new documentation-first API. It does not promise
compatibility with legacy package APIs, previous workspace prototypes or serialized
workflow state. Migration is an explicit port, not an automatic state conversion.

1. Describe entry points in a command catalog and connect related catalogs.
2. Move reusable behavior into documented module methods; executable fences contain
   method bodies while Markdown supplies declarations and contracts.
3. Use native ESM dependency/caching semantics. Restart hosts after source changes.
4. Validate application documents with do-md and define application-owned state and
   reconciliation policies explicitly.
5. Register callbacks through invocation context, with schemas and explicit lifetime.
6. Use generic process/service adapters and project-level Markdown harness bindings.
   Provider configuration, prompts and response interpretation belong to those
   modules rather than the library or its common adapter interface.
7. Validate through --check, exercise the real workflow, then verify failure/recovery.

See the authoring guide, generated reference and executable examples for the new
contract. Programmatic consumers use the declared export subpaths, not private sources.

## Replace hidden-directory discovery

Move application catalogs, modules, tests and templates into your preferred source
layout, preserving or adjusting their document-relative references. Declare the
catalog and test location in package.json:

```json
"rundown": {
  "commands": "./commands.md",
  "tests": "./tests"
}
```

No legacy lookup fallback is provided. The nearest package boundary is authoritative;
unconfigured child packages do not inherit ancestor catalogs. Use `--commands` or
explicit library entry paths for independent catalogs. Install native dependencies
through the existing package manager. Dot directories are application-owned data,
not implicit source/configuration.

## Initialization now registers existing paths

The fixed greeting initializer has been removed. Use npm for package/dependency
setup, write or copy source files, then run `rndn --init commands.md tests/`.
The catalog is required and the test target is optional. Both must already exist.
Only the nearest manifest is updated; omitted test declarations and unrelated
metadata are preserved. Repeating equivalent paths is a no-op; supplying different
paths explicitly reconfigures the defaults. Bare --init prints usage.

Native callers use `initProject(catalog, {cwd, tests?, signal?})` instead of the old
options-only initializer. Source generation remains in the separate authoring tools.
