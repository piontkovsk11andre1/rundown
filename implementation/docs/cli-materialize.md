# CLI: `materialize`

Run a full task pass and record snapshot-backed implementation history.

`materialize` is a convenience wrapper over `run` that forces a full execution pass and then records implementation snapshots at completed migration boundaries.

- `--all`
- snapshot recording via the same boundary contract used by `snapshot`

Unlike historical commit-based behavior, `materialize` does not require git commit metadata to make the result restorable by `revert`.

Use `materialize` when you want to execute all tasks and keep durable, snapshot-backed implementation restore history.

Command role split:

- `materialize`: execute and apply work, then record/confirm boundary snapshots for that completed state.
- `snapshot`: explicitly persist implementation snapshot history on demand without running tasks.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown materialize <source> [options] -- <command>
rundown materialize <source> [options] --worker <pattern>
```

`rndn materialize <source> [options]` is alias-equivalent.

Arguments:

- `<source>`: file, directory, or glob to scan for Markdown tasks.

Options:

- `materialize` accepts the same run-like options as `run` (`--verify`, `--repair-attempts`, `--sort`, `--trace`, `--vars-file`, `--worker`, and related flags).
- Explicit user-supplied values for `--all` are ignored because `materialize` enforces full-run behavior.

Auto-compact defaults:

- You can opt in persistently by setting `autoCompact.beforeExit=true` in config.
- Defaults remain off unless explicitly enabled by config or `--compact-before-exit`.

Examples:

```bash
# Execute all tasks and record implementation snapshot history
rundown materialize roadmap.md

# Materialize a directory source
rundown materialize docs/

# Materialize with explicit worker pattern
rundown materialize roadmap.md --worker "opencode run $file"
```
