# Global options

Flags that can appear at the program level (before the subcommand) or are otherwise shared across commands.

## `--config-dir <path>`

Sets the `.rundown/` config directory explicitly.

- Disables the upward-walk discovery.
- Required to be a valid directory for most commands; `init` accepts a missing path because it will create it.
- Invalid explicit paths fail fast with a non-zero exit.
- Affects: templates, vars-file lookup, runs, logs, locale, worker-health state.
- **Does not** affect lockfile location — locks are always source-relative ([../execution/completion-and-locks.md](../execution/completion-and-locks.md)).

## `--agents`

Root-level only. Prints the canonical [AGENTS.md](../../AGENTS.md) guidance to stdout and exits 0. Used by agents and CI workflows that need to fetch the worker contract without filesystem access.

## Output flags

These appear on most worker-driven commands:

| Flag | Effect |
|---|---|
| `--show-agent-output` | Mirror worker stdout to terminal in real time |
| `--print-prompt` | Print rendered prompt and exit (no spawn) |
| `--dry-run` | Report what would happen, do not spawn |
| `--keep-artifacts` | Retain run artifact dirs on success |
| `--trace` | Enable JSONL trace writer |
| `--verbose` | Emit resolution diagnostics |

## Lock-related flags

| Flag | Effect |
|---|---|
| `--force-unlock` | Break a stale lock at startup (after metadata sanity check) |

## Worker passthrough

Two equivalent ways to override worker resolution from the CLI:

```
rundown run tasks.md --worker "opencode run --file \$file \$bootstrap"
rundown run tasks.md -- opencode run --file '$file' '$bootstrap'
```

The `--` form is preferred when the worker pattern contains shell-special characters; everything after `--` is captured as an argv array verbatim. See [../workers/resolution-order.md](../workers/resolution-order.md) precedence rules.

## Argv preprocessing

[src/presentation/cli-argv.ts](../../implementation/src/presentation/cli-argv.ts) handles:

- splitting at `--` for worker passthrough,
- normalizing repeatable `-V key=value` template-var flags,
- stripping the bin alias name (`rd` vs `rundown`) from comparisons.

This runs before Commander parsing.
