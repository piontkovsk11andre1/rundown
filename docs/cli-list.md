# CLI: `list`

List unchecked tasks across the source.

Use `--all` to include checked tasks in the output.

Nested checkbox tasks and non-checkable list items are rendered under their parent task with indentation, preserving source order.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown list <source> [options]
```

Arguments:

- `<source>`: Markdown file, directory, or glob to scan.

Options:

| Option | Description | Default |
|---|---|---|
| `--sort <sort>` | File sort mode: `name-sort`, `none`, `old-first`, `new-first`. | `name-sort` |
| `--all` | Include checked and unchecked tasks (unchecked only by default). | off |

Output semantics:

- Output is grouped by file in sorted file order; tasks within each file are listed in source order.
- Each file header shows the filtered task count for that file.
- Without `--all`, only unchecked tasks are listed.
- Tasks that are unchecked but still have unchecked descendants are rendered as blocked.
- Non-checkable list items remain visible under their parent task hierarchy.
- If no Markdown files match `<source>`, `list` reports no matching files and exits with no-work status.
- If files match but no tasks satisfy the current filter, `list` reports that no tasks were found and exits with no-work status.

Examples:

```bash
rundown list .
rundown list roadmap.md --all
rundown list docs/ --sort old-first
```

Example hierarchical output:

```text
TODO.md:1 [#0] Release prep (blocked — has unchecked subtasks)
  TODO.md:2 - Confirm target branch
  TODO.md:3 [#1] Rewrite README opening
    TODO.md:4 [#2] Capture before/after screenshots
```

In this example, `Confirm target branch` is a non-checkable detail item, and the checkbox children are shown as nested task lines.
