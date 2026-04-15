# CLI: `loop`

Run repeated `call`-style full clean passes against a source, with a cooldown between iterations.

`loop` composes `call` semantics per iteration (`--all --clean --cache-cli-blocks`) and then waits before starting the next pass.

Synopsis:

```bash
rundown loop <source> [options] -- <command>
rundown loop <source> [options] --worker <pattern>
```

Options:

| Option | Description | Default |
|---|---|---|
| `--cooldown <seconds>` | Delay between iterations. `0` starts the next pass immediately. | `60` |
| `--iterations <n>` | Stop after `n` iterations. If omitted, loop runs until interrupted. | unlimited |
| `--continue-on-error` | Continue looping after a failed iteration instead of exiting immediately. | off |

`loop` also accepts all run-like options (`--verify`, `--repair-attempts`, `--commit`, `--worker`, `--trace`, etc.), which are forwarded to each inner `call` iteration.

Behavior notes:

- Infinite mode (default): if `--iterations` is omitted, `loop` runs until interrupted.
- Bounded mode: `--iterations <n>` runs exactly `n` iterations, then exits.
- Failure handling default: stop on first non-zero iteration exit code.
- Failure handling override: with `--continue-on-error`, failed iterations are logged and the loop continues after cooldown.
- Interrupt handling: `Ctrl+C` during cooldown exits cleanly without waiting for the full cooldown.
- Mode support: `loop` supports `--mode wait` only (interactive modes are rejected).

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
