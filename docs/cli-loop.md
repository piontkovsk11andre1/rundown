# CLI: `loop`

Run repeated `call`-style full clean passes against a source, with a cooldown between iterations.

`loop` composes `call` semantics per iteration (`--all --clean --cache-cli-blocks`) and then waits before starting the next pass.

## Global option: `--config-dir <path>`

`--config-dir <path>` is available on every command.

- If provided, rundown uses that directory as the `.rundown` config root and skips upward discovery.
- If omitted, rundown discovers `.rundown/` by walking upward from the command start directory until it finds one.
- If discovery finds nothing, command-specific fallback behavior applies.

Synopsis:

```bash
rundown loop <source> [options] -- <command>
rundown loop <source> [options] --worker <pattern>
rd loop <source> [options]
```

Arguments:

- `<source>`: Markdown file, directory, or glob to scan.

Options:

| Option | Description | Default |
|---|---|---|
| `--cooldown <seconds>` | Delay between iterations. Must be a positive integer (`1` or higher). | `5` |
| `--iterations <n>` | Stop after `n` iterations. If omitted, loop runs until interrupted. | unlimited |
| `--time-limit <seconds>` | Global wall-clock runtime cap for the full loop session. Must be a positive integer when set. | disabled |
| `--continue-on-error` | Continue looping after a failed iteration instead of exiting immediately. | off |

`loop` also accepts all run-like options (`--verify`, `--repair-attempts`, `--commit`, `--worker`, `--trace`, etc.), which are forwarded to each inner `call` iteration.

Commit-specific forwarding is supported in loop mode too:

- `--commit` enables auto-commit after successful iteration completion.
- `--commit-message <template>` forwards custom commit message templating to each iteration.
- `--commit-mode <mode>` is respected per iteration; because `loop` enforces clean all-task passes, both `per-task` and `file-done` remain valid.

Behavior notes:

- Infinite mode (default): if `--iterations` is omitted, `loop` runs until interrupted.
- Bounded mode: `--iterations <n>` runs exactly `n` iterations, then exits.
- Time-bound mode: `--time-limit <seconds>` caps total loop runtime; timeout is checked before each iteration and during cooldown.
- Failure handling default: stop on first non-zero iteration exit code.
- Failure handling override: with `--continue-on-error`, failed iterations are logged and the loop continues after cooldown.
- Interrupt handling: `Ctrl+C` during cooldown exits cleanly without waiting for the full cooldown.
- Mode support: `loop` supports `--mode wait` only (interactive modes are rejected).
- Conditional sibling short-circuit remains separate: `optional:` / `skip:` only skip siblings in the current parent scope and do not exit the outer loop.
- Terminal prefixes (`quit:`/`exit:`/`end:`/`break:`/`return:`) stop the outer loop immediately after the current iteration finalizes.
- Terminal stop intent has higher precedence than `--continue-on-error`; cooldown wait is skipped because no next iteration is scheduled.

Lifecycle output:

- Start line includes bounds and timing config, for example: `Loop starting: iterations=unlimited, cooldown=5s, time-limit=60s.`
- Timeout completion line is deterministic, for example: `Loop completed: time limit reached (elapsed=60s, limit=60s).`
- Final summary always includes total/succeeded/failed iteration counts.

Exit codes:

- `0`: bounded iterations completed, or graceful interrupt (`SIGINT`) during loop/cooldown.
- `1`: iteration execution error (when `--continue-on-error` is not set).
- `2`: iteration validation failure (when `--continue-on-error` is not set).

Examples:

```bash
# Continuous processing with 10-second cooldown
rundown loop roadmap.md --cooldown 10

# Exactly 3 iterations with 5-second cooldown
rundown loop docs/ --cooldown 5 --iterations 3

# Keep looping even if an iteration fails
rundown loop "tasks/**/*.md" --cooldown 30 --continue-on-error
```
