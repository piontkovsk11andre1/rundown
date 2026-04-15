# CLI: `log`

`rundown log` shows completed run history in a compact, one-line-per-run format to help pick revert targets.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown log [options]
```

Arguments:

- None.

Default behavior:

- Shows only runs with status `completed`.
- Orders runs newest-first (same order as saved artifacts metadata).
- Prints one compact line per run: short run ID, absolute local timestamp (ISO-8601 with numeric offset), relative timestamp, status, task summary, source, command, commit SHA (if present), and revertable indicator.
- Text-mode absolute timestamps are local display values; persisted run metadata (`startedAt`/`completedAt`) remains UTC ISO-8601.
- Non-revertable entries are dimmed in terminal output.

Options:

| Option | Description |
|---|---|
| `--revertable` | Show only revertable runs (`status=completed` and metadata contains `extra.commitSha`). |
| `--command <name>` | Filter by command name (for example `run`, `plan`, `revert`, `reverify`). |
| `--limit <n>` | Show only the first `n` matching runs. |
| `--json` | Print matching runs as JSON for machine consumption. |

Examples:

```bash
rundown log
rundown log --revertable
rundown log --command run --limit 5
rundown log --json
```

`--json` outputs an array of run entries with fields such as `runId`, `shortRunId`, `commandName`, `status`, `relativeTime`, `taskSummary`, `source`, `commitSha`, `shortCommitSha`, `revertable`, `startedAt`, and `completedAt`.

Automation note: prefer `rundown log --json` for scripts. The default text view is optimized for operators and includes additive timestamp rendering for readability.
