# CLI: `call`

Run a full clean pass across all tasks in one command.

`call` is a convenience wrapper over `run` that forces these options per invocation:

- `--all`
- `--clean`
- `--cache-cli-blocks`

This makes `call` the preferred command when you want an end-to-end clean execution pass without repeating flags.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown call <source> [options] -- <command>
rundown call <source> [options] --worker <pattern>
rd call <source> [options]
```

Arguments:

- `<source>`: Markdown file, directory, or glob to scan.

Options:

- Supports the same run-like options as `rundown run` (verification/repair, commit/hook, output, vars, lock, and worker options).
- `--all`, `--clean`, and `--cache-cli-blocks` are always enforced by `call`; user-supplied values for those flags are ignored.

Behavior notes:

- Explicit user-supplied values for `--all`, `--clean`, and `--cache-cli-blocks` are ignored because `call` enforces them.

Examples:

```bash
# Full clean pass across one task file
rundown call roadmap.md

# Full clean pass across a directory source
rundown call docs/
```
