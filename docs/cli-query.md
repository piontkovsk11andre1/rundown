# CLI: `query`

`rundown query <text>` researches the codebase, plans investigation steps, and executes a query workflow.

`query` orchestrates three phases:

1. research context enrichment,
2. plan/task decomposition,
3. execution and result aggregation.

By default, output is Markdown. Use `--format` to emit JSON or strict pass/fail style output.

Synopsis:

```bash
rundown query <text> [options] -- <command>
rundown query <text> [options] --worker <pattern>
```

Arguments:

- `<text>`: natural-language query to investigate.

Options:

| Option | Description | Default |
|---|---|---|
| `--dir <path>` | Target directory to analyze. | current working directory |
| `--format <format>` | Output format: `markdown`, `json`, `yn`, `success-error`. | `markdown` |
| `--output <file>` | Write final query output to a file instead of stdout. | unset |
| `--skip-research` | Skip phase 1 and start from plan phase. | off |
| `--mode <mode>` | Query mode. Currently only `wait` is supported. | `wait` |
| `--scan-count <n>` | Max plan scan iterations (omit for convergence-driven unlimited mode). | unset |
| `--max-items <n>` | Cap total TODO items added across all plan scans. | unset |
| `--deep <n>` | Additional nested plan depth passes after top-level scans. | `0` |
| `--dry-run` | Show planned query orchestration without running workers. | off |
| `--print-prompt` | Print rendered query prompts and exit `0`. | off |
| `--keep-artifacts` | Preserve runtime prompts, logs, and metadata under `.rundown/runs/`. | off |
| `--show-agent-output` | Show worker stdout/stderr during execution. | off |
| `-v, --verbose` | Show detailed per-task run diagnostics. | off |
| `-q, --quiet` | Suppress info-level output. | off |
| `--trace` | Write structured trace events to run and global trace logs. | off |
| `--trace-stats` | Insert inline task trace statistics under completed TODOs in the source Markdown. | off |
| `--trace-only` | Skip task execution and run only trace enrichment on the latest completed artifact run. | off |
| `--force-unlock` | Break stale source lockfiles before phase locks. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (alternative to `-- <command>`). | unset |

Examples:

```bash
# Default markdown output
rundown query "Where do we classify worker failures?"

# JSON output written to file
rundown query "Which commands support --trace?" --format json --output reports/query.json

# Skip research and run plan+execute only
rundown query "Does memory-clean remove index entries?" --skip-research
```
