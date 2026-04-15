# CLI: `make`

Create a new Markdown file from seed text, then run `research` followed by `plan` on that same file.

Synopsis:

```bash
rundown make "<seed-text>" "<markdown-file>" [options] -- <command>
rundown make "<seed-text>" "<markdown-file>" [options] --worker <pattern>
```

`make` is a composition command for the authoring bootstrap flow:

1. create target Markdown file,
2. write `seed-text` as the initial file body,
3. run `research` on that file,
4. run `plan` on that file.

Execution is sequential and fail-fast:

- If file creation fails, `research` and `plan` do not run.
- If `research` fails, `plan` does not run.
- If `plan` fails, `make` exits non-zero and preserves generated artifacts per normal command behavior.

Input rules:

- Exactly two positional arguments are required: `<seed-text>` and `<markdown-file>`.
- Target extension must be `.md` or `.markdown`.
- Target must be a file path (directories are rejected).
- Existing files are not overwritten; `make` fails on collisions.
- Missing parent directories are treated as an error.

Options:

| Option | Description | Default |
|---|---|---|
| `--mode <mode>` | Make execution mode. Only `wait` is supported for deterministic non-interactive chaining. | `wait` |
| `--scan-count <n>` | Maximum clean-session scan iterations for the `plan` phase. Must be a safe positive integer. | `3` |
| `--force-unlock` | Remove stale source lockfiles before each phase lock acquisition. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render phase prompts + execution intent and exit without running workers. | off |
| `--print-prompt` | Print rendered phase prompts and exit `0` without running workers. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show worker stdout/stderr during phase execution (hidden by default). | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `make` resolves worker input using the same command resolution behavior as `research` and `plan`.

Examples:

```bash
# One-step authoring bootstrap: create -> research -> plan
rundown make "please do something" "8. Do something.md"

# Use .markdown extension
rundown make "Draft migration plan" "docs/migration.markdown"

# Preview prompts without running workers
rundown make "Release prep" "docs/release-prep.md" --print-prompt
```
