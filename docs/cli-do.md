# CLI: `do`

Create a new Markdown task file from seed text (`make` workflow), then execute all tasks from that same file (`run --all`).

`do` is a convenience composition command for end-to-end bootstrap + execution:

1. create target file and write seed text,
2. run `research`,
3. run `plan`,
4. run execution with `run --all` on the generated file.

Execution is sequential and fail-fast across phases.

Synopsis:

```bash
rundown do "<seed-text>" "<markdown-file>" [options] -- <command>
rundown do "<seed-text>" "<markdown-file>" [options] --worker <pattern>
```

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
