# `rundown loop`

Use `rundown loop` to run a task file repeatedly with optional bounds and cooldown.

## Synopsis

```bash
rundown loop <source> [options]
```

## Options

- `--iterations <n>`: maximum number of loop iterations. If omitted, the loop is unbounded by iteration count.
- `--cooldown <seconds>`: sleep between iterations.
- `--continue-on-error`: continue running later iterations even when one iteration exits non-zero.
- `--time-limit <seconds>`: global wall-clock runtime budget for the full loop invocation.

## Global runtime limit

`--time-limit` applies to the outer loop lifecycle, not per-iteration task execution.

- The timer starts when loop execution begins, before the first iteration.
- The budget is checked before each new iteration.
- During cooldown, waiting stops early when the time budget is exhausted.
- In-flight iterations are not force-killed solely because the global budget expires.
- On timeout, the loop exits gracefully and still prints final iteration totals.

## Interaction with other loop controls

- `--iterations` and `--time-limit` are both active bounds; whichever is reached first ends the loop.
- Task-level terminal stop intents (`quit:`, `exit:`, `end:`, `break:`, `return:`) still stop the loop as usual.
- `--continue-on-error` only affects non-zero iteration handling and does not bypass `--time-limit`.
- `Ctrl+C` handling during cooldown remains graceful.

## Examples

Run up to 10 iterations with a 2-second cooldown:

```bash
rundown loop tasks.md --iterations 10 --cooldown 2
```

Run an unlimited loop with a 5-minute global cap:

```bash
rundown loop tasks.md --time-limit 300
```

Keep going on errors, but stop after 15 minutes total:

```bash
rundown loop tasks.md --continue-on-error --time-limit 900
```
