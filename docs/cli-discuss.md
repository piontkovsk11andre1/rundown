# CLI: `discuss`

Select the next unchecked task and start a discussion session for task refinement before execution.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown discuss [source] [options] -- <command>
rundown discuss [source] [options] --worker <pattern>
```

`discuss` uses the same source resolution and task-selection logic as `run`, but opens a discussion-oriented worker session (default `--mode tui`) instead of executing the task implementation flow.

When `--run <id|prefix|latest>` is provided, `discuss` loads a finished artifact run and opens a post-run discussion session for that run instead of selecting a new unchecked task from source Markdown.

`--worker` is optional when rundown can resolve a worker for `discuss` from `.rundown/config.json`.

During this session, the agent may edit the Markdown source task text to improve scope and clarity (for example rewriting task wording, splitting tasks, or adding sub-items). `discuss` does not mutate checkbox completion state.

Arguments:

| Argument | Description |
|---|---|
| `[source]` | Markdown file, directory, or glob to scan for the next unchecked task. Optional when using `--run`; otherwise required. |

Options:

| Option | Description | Default |
|---|---|---|
| `--run <id|prefix|latest>` | Discuss a finished artifact run by exact run id, unique run id prefix, or `latest`. | unset |
| `--mode <tui|wait>` | Discussion worker mode. `tui` opens an interactive terminal UI; `wait` runs non-interactively. | `tui` |
| `--sort <name-sort|none|old-first|new-first>` | Source ordering strategy before task selection. | `name-sort` |
| `--dry-run` | Resolve task + render discuss prompt, print planned execution, and exit `0` without running worker. | off |
| `--print-prompt` | Print rendered discuss prompt and exit `0` without running worker. | off |
| `--keep-artifacts` | Keep discuss run artifacts under `<config-dir>/runs/` even on success. | off |
| `--trace` | Write structured trace events to `<config-dir>/runs/<id>/trace.jsonl` and mirror to `<config-dir>/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--show-agent-output` | Show discussion worker stdout/stderr transcript output during the discuss session (hidden by default). | off |
| `--force-unlock` | Remove stale source lockfile before acquiring discuss lock. Active locks held by live processes are not removed. | off |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Examples:

```bash
rundown discuss roadmap.md
rundown discuss docs/
rundown discuss tasks.md --mode wait
rundown discuss --run latest
rundown discuss --run run-20260319T222645632Z-04e84d73
rundown discuss roadmap.md --print-prompt
rundown discuss roadmap.md --dry-run
```
