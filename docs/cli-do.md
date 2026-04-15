# CLI: `do`

Create a new Markdown task file from seed text (`make` workflow), then execute all tasks from that same file (`run --all`).

`do` is a convenience composition command for end-to-end bootstrap + execution:

1. create target file and write seed text,
2. run `research`,
3. run `plan`,
4. run execution with `run --all` on the generated file.

Execution is sequential and fail-fast across phases.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown do "<seed-text>" "<markdown-file>" [options] -- <command>
rundown do "<seed-text>" "<markdown-file>" [options] --worker <pattern>
```

Arguments:

- `<seed-text>`: Initial text used to seed the new Markdown file.
- `<markdown-file>`: Output Markdown file to create and execute.

Options:

- Supports `make`-phase options for bootstrap (`--scan-count`, `--dry-run`, `--print-prompt`, `--vars-file`, `--var`, `--worker`, etc.).
- Supports run-like execution options for the final phase (`--sort`, `--verify/--no-verify`, `--repair-attempts`, `--commit`, `--on-complete`, `--on-fail`, `--redo`, `--clean`, `--rounds`, and related flags).

Examples:

```bash
# End-to-end: create, enrich, plan, then execute all generated tasks
rundown do "ship release checklist" "docs/release.md"

# Same flow with explicit clean execution behavior
rundown do "ship release checklist" "docs/release.md" --clean --rounds 2
```
