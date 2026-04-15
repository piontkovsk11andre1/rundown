# CLI: `undo`

Undo completed task runs using AI-generated reversal actions from execution artifacts.

Unlike `revert`, `undo` is semantic (artifact/context driven) rather than commit-level git history reversal.

Synopsis:

```bash
rundown undo [options] -- <command>
rundown undo [options] --worker <pattern>
```

Options:

| Option | Description | Default |
|---|---|---|
| `--run <id|latest>` | Target artifact run id or `latest`. | `latest` |
| `--last <n>` | Undo the last `n` completed runs. | `1` |
| `--force` | Bypass clean-worktree safety checks. | off |
| `--dry-run` | Show what would be undone without changing files. | off |
| `--keep-artifacts` | Preserve undo run artifacts under `<config-dir>/runs/`. | off |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |
