# CLI: `run`

Scan a file, directory, or glob, select the next runnable task, execute it, verify it, optionally repair it, and mark it complete only after verification succeeds.

With `--all` (or the shorthand `all` command), process tasks sequentially until all are complete or a failure occurs.

Agent stdout/stderr is hidden by default. Use `--show-agent-output` to display worker output for `execute`, `verify`, and `plan` stages while keeping `discuss` worker output silent.

Examples:

```bash
rundown run roadmap.md
rundown run docs/
rundown run "notes/**/*.md"
rundown run roadmap.md --all
rundown run roadmap.md --redo
rundown run roadmap.md --reset-after
rundown run roadmap.md --clean
rundown all roadmap.md
rundown run tasks.md --show-agent-output
```

PowerShell-safe form:

```powershell
rundown run docs/
rundown run docs/ --all
rundown all docs/
rundown run docs/ --show-agent-output
```

Agent output notes (`run --show-agent-output`):

- Default behavior (option omitted): suppress worker-derived `text` and `stderr` transcript output across stages.
- With `--show-agent-output`: show worker-derived `text` and `stderr` transcript output for `execute`, `verify`, and `plan` stages (including inline `cli:` task stdout/stderr).
- `discuss` remains silent for worker transcript output even when `--show-agent-output` is set.
- Still visible: rundown lifecycle/status messages (`info`, `warn`, `error`, `success`, `task`).
- Still visible: hook output from `--on-complete` and `--on-fail` (intentionally out of scope for this option).
- Artifacts/traces still capture output for audit/debug; terminal suppression does not disable persistence.
