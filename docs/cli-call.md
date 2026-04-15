# CLI: `call`

Run a full clean pass across all tasks in one command.

`call` is a convenience wrapper over `run` that forces these options per invocation:

- `--all`
- `--clean`
- `--cache-cli-blocks`

This makes `call` the preferred command when you want an end-to-end clean execution pass without repeating flags.

Synopsis:

```bash
rundown call <source> [options] -- <command>
rundown call <source> [options] --worker <pattern>
rd call <source> [options]
```

Behavior notes:

- Accepts the same run-like options as `run` (verification/repair, commit/hook, output, vars, lock, and worker options).
- Explicit user-supplied values for `--all`, `--clean`, and `--cache-cli-blocks` are ignored because `call` enforces them.

Examples:

```bash
# Full clean pass across one task file
rundown call roadmap.md

# Full clean pass across a directory source
rundown call docs/
```
