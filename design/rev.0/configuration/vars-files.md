# Vars files

External template variable sources, layered with CLI flags.

## Files

`--vars-file <path>` accepts:

- JSON files (`*.json`),
- YAML files (`*.yaml`, `*.yml`).

Loaded by [src/infrastructure/adapters/fs-template-vars-loader-adapter.ts](../../implementation/src/infrastructure/adapters/fs-template-vars-loader-adapter.ts) (port: `TemplateVarsLoaderPort`). Domain helpers in [src/domain/template-vars.ts](../../implementation/src/domain/template-vars.ts).

## Default lookup

If `--vars-file` is not given, rundown looks for `<config-dir>/vars.json` (or `.yaml`/`.yml`) and uses it if present. Missing default file is **not** an error.

If `--vars-file` is given as a flag-only (no value), rundown looks for the default file and errors if it is missing — this is the explicit-but-default form.

If `--vars-file <path>` is given with a value, rundown reads that path and errors if it is missing.

## CLI flags

`--var key=value` adds a single variable. Repeatable. Flag values override file-loaded values.

```
rundown run tasks.md --vars-file vars.json -V env=staging -V build=42
```

## Merge order

```
built-in (run-id, file, task, …)
        ↓
vars file (default lookup or --vars-file)
        ↓
--var flags
        ↓
per-iteration vars (e.g. for: $item)
```

Later layers override earlier. This means `--var` always trumps a file, and per-iteration vars (set by tools like `for:` and `get:`) trump everything for the duration of the iteration.

## Type coercion

Values from `--var` flags are strings. JSON/YAML files preserve their native types. Templates render values as their default string representation; complex objects can be rendered explicitly with template helpers.

## Validation

- Vars file parsing errors are fatal; the CLI exits with a path-specific error.
- Top-level structure must be an object; arrays at the root are rejected.
- Variable names should be valid identifiers (warning on dotted names, since dotted names interfere with template path syntax).
