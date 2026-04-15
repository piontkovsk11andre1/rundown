# CLI: `next`

Show the next runnable unchecked task without executing it.

`next` resolves the source set, applies file sorting, then selects the first runnable task in scan order.

A task is considered runnable when it is unchecked and has no unchecked descendants.

Synopsis:

```bash
rundown next <source> [options]
```

Arguments:

- `<source>`: Markdown file, directory, or glob to scan.

Options:

| Option | Description | Default |
|---|---|---|
| `--sort <sort>` | File sort mode: `name-sort`, `none`, `old-first`, `new-first`. | `name-sort` |

Output semantics:

- Success emits an informational line with the selected task position in its file (`Next task: <n>/<total> in <file>`), then prints that task with nested checklist children/sub-items.
- If no Markdown files match `<source>`, `next` reports no matching files and exits with no-work status.
- If files match but no runnable unchecked task exists, `next` reports that no unchecked tasks were found and exits with no-work status.

Example:

```bash
rundown next docs/
rundown next roadmap.md --sort old-first
```
