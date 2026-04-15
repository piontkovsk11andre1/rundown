# CLI: `research`

Enrich a single Markdown document with context and structure before planning.

`research` rewrites a document body with expanded feature detail, implementation context, design constraints, and planning scaffolding. It is intentionally upstream of `plan`:

1. author drafts a thin feature doc,
2. `rundown research <source>` enriches it,
3. `rundown plan <source>` appends actionable TODOs,
4. `rundown run <source>` executes tasks.

## Input rules

- Exactly one file path is required.
- File extension must be `.md` or `.markdown`.
- Directories and globs are rejected for `research`.

## Behavior and safety guards

- Worker output is treated as the full replacement Markdown document.
- Existing checkbox state must remain unchanged, or the write is rejected and rolled back.
- New unchecked TODO items (`- [ ]`) are not allowed in research output.
- `research` runs a single pass (no `--scan-count` convergence loop).

## Options

| Option | Description | Default |
|---|---|---|
| `--mode <mode>` | Research execution mode: `wait`, `tui`. | `wait` |
| `--force-unlock` | Remove stale source lockfile before acquiring the research lock. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render the research prompt + execution intent and exit without running the worker. | off |
| `--print-prompt` | Print the rendered research prompt and exit `0` without running the worker. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `.rundown/runs/` even on success. | off |
| `--show-agent-output` | Show worker stdout/stderr during execution (hidden by default). | off |
| `--trace` | Write structured trace events to `.rundown/runs/<id>/trace.jsonl` and mirror them to `.rundown/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |

## Worker and prompt resolution

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `research` resolves the worker from `.rundown/config.json` using the standard cascade.
- Custom research prompts can be supplied via `.rundown/research.md`; otherwise the built-in research template is used.

## Prompt variable behavior

- `--var key=value` injects a template variable.
- `--vars-file path/to/file.json` loads variables from a JSON file.
- `--vars-file` (without a path) loads `<config-dir>/vars.json`.
- Direct `--var` entries override values loaded from `--vars-file`.
- During fenced `cli` block execution, variables are exported to the spawned shell environment as `RUNDOWN_VAR_<UPPERCASE_KEY>`.

## `--dry-run` and `--print-prompt`

- If both are provided, `--print-prompt` takes precedence.
- For `research`, both flags target the research prompt.
- Fenced `cli` blocks run during `--print-prompt` so output matches worker-visible prompts (unless `--ignore-cli-block` is set).
- Fenced `cli` blocks do not run during `--dry-run`; prompts remain unexpanded.
- Worker command validation still applies. Missing or invalid worker input can return exit code `1`.

If no CLI worker is provided and no worker is resolvable from config, the command exits `1` with:

`No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.`

## Examples

```bash
# Enrich a thin spec before planning
rundown research docs/spec.md

# Inspect research prompt only
rundown research docs/spec.md --print-prompt

# Dry-run with default vars file plus an override
rundown research docs/spec.md --dry-run --vars-file --var ticket=ENG-42
```

## Exit codes

- `0` - command completed successfully
- `1` - execution or configuration error
- `2` - validation failed
- `3` - no actionable target
