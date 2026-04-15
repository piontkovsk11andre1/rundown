# CLI: `all` (legacy alias)

`rundown all <source>` remains available as a legacy compatibility alias for `rundown run <source> --all`.

It scans the selected source, executes runnable tasks in order, verifies each result, and continues until all tasks are complete or a failure occurs.

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
