# CLI: `explore`

Run `research` and then `plan` on the same existing Markdown document.

`explore` is a convenience alias for the common enrichment flow on docs that already exist:

1. `rundown research <markdown-file>` enriches context and structure,
2. `rundown plan <markdown-file>` synthesizes actionable TODO items.

Synopsis:

```bash
rundown explore <markdown-file> [options] -- <command>
rundown explore <markdown-file> [options] --worker <pattern>
```

Usage example:

```bash
rundown explore docs/spec.md
```

Execution is sequential and fail-fast:

- `research` runs first.
- If `research` exits non-zero, `plan` is skipped.
- If both phases succeed, `explore` exits `0`.
- If either phase fails, `explore` returns the failing phase exit code.

Input rules:

- Exactly one file path is required.
- File extension must be `.md` or `.markdown`.
- Directories and globs are rejected.

Options:

| Option | Description | Default |
|---|---|---|
| `--mode <mode>` | Shared execution mode forwarded to both phases (`research` + `plan`). Use `wait` for compatibility with `plan`. | `wait` |
| `--scan-count <n>` | Planner-only maximum clean-session scan iterations forwarded to `plan`. Must be a safe positive integer. | `3` |
| `--deep <n>` | Planner-only nested pass count forwarded to `plan`. Must be a safe non-negative integer. | `0` |
| `--max-items <n>` | Planner-only item cap forwarded to `plan`. | unset |
| `--force-unlock` | Remove stale source lockfiles before each phase lock acquisition. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render phase prompts + execution intent and exit without running workers. | off |
| `--print-prompt` | Print rendered phase prompts and exit `0` without running workers. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show worker stdout/stderr during phase execution (hidden by default). | off |
| `-v, --verbose` | Show detailed per-task run diagnostics within grouped output for both phases. | off |
| `-q, --quiet` | Suppress info-level output (info, success, progress, grouped status) across both phases. | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `explore` resolves worker input using the same command resolution behavior as `research` and `plan`.

Examples:

```bash
# One-step enrichment for an existing document: research -> plan
rundown explore docs/spec.md

# Include nested TODO generation in the plan phase
rundown explore docs/spec.md --scan-count 3 --deep 1

# PowerShell-safe worker form (explicit worker override)
rundown explore docs/spec.md --worker "opencode run"
```
