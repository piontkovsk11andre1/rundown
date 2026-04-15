# CLI: `materialize`

Run a full task pass with revertable defaults.

`materialize` is a convenience wrapper over `run` that forces these options per invocation:

- `--all`
- `--revertable` (equivalent to `--commit --keep-artifacts`)

Use `materialize` when you want to execute all tasks while keeping artifact state and commit metadata aligned for reversal flows.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown materialize <source> [options] -- <command>
rundown materialize <source> [options] --worker <pattern>
rd materialize <source> [options]
```

Arguments:

- `<source>`: file, directory, or glob to scan for Markdown tasks.

Options:

- `materialize` accepts the same run-like options as `run` (`--verify`, `--repair-attempts`, `--sort`, `--trace`, `--vars-file`, `--worker`, and related flags).
- Explicit user-supplied values for `--all` and `--revertable` are ignored because `materialize` enforces them.

Examples:

```bash
# Execute all tasks with revertable behavior
rundown materialize roadmap.md

# Materialize a directory source
rundown materialize docs/

# Materialize with explicit worker pattern
rundown materialize roadmap.md --worker "opencode run $file"
```
