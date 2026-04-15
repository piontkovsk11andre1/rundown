# CLI: `all` (legacy alias)

`rundown all <source>` remains available as a legacy compatibility alias for `rundown run <source> --all`.

It scans the selected source, executes runnable tasks in order, verifies each result, and continues until all tasks are complete or a failure occurs.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown all <source> [options] -- <command>
rundown all <source> [options] --worker <pattern>
rd all <source> [options]
```

Arguments:

- `<source>`: Markdown file, directory, or glob to process.

Options:

- Supports the same options as `rundown run`.
- `--all` behavior is implicit; you do not need to pass `--all` when using `all`.

Examples:

```bash
# Process every runnable task in one file
rundown all roadmap.md

# Process all tasks in a directory
rundown all docs/

# Run with visible worker transcript output
rundown all tasks.md --show-agent-output
```

See also: [cli-run.md](cli-run.md).
