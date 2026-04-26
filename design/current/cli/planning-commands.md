# Planning and research commands

Worker invocations that **don't** flip checkboxes; they produce or transform content.

## `plan <source>`

Scan-based TODO generator. Implementation: [src/application/plan-task.ts](../../implementation/src/application/plan-task.ts).

| Option | Effect |
|---|---|
| `--scan-count <n>` | Independent scans (default per-config) |
| `--max-items <n>` | Cap added items per scan |
| `--deep <n>` | Run `n` deep-pass rounds for child TODO generation under leaf tasks |
| `--mode <mode>` | Planner mode (e.g. `default`, `migrate-planner`) |
| `--dry-run` | Validate planner output without writing |
| `--print-prompt` | Print prompt without running |
| `--loop` | Repeat scans until convergence |
| `--worker <pattern>` | Override worker |

**Additive-only contract**: planner output may only contain unchecked `- [ ]` lines; rundown rejects any non-additive change (toggling completion, removing items, reordering). Insertion strategy:

- existing TODOs in source → append after the last TODO line,
- no existing TODOs → append at end of document.

Convergence: the loop ends when a scan adds zero new items, or when `scan-count` is reached.

## `research <source>`

Research-oriented worker invocation. Produces output without executing tasks. The output may be saved to memory or written to a target file via `--output`.

## `explore <source>`

Combined plan + research pass. Useful for "throw a directory at it and tell me what's there".

## `query <source>`

Non-interactive single-turn worker query. Reads the source as context, asks one question, returns one answer. Compared to `discuss`, `query` is non-interactive and stateless.

| Option | Effect |
|---|---|
| `--format <fmt>` | Output format (text, json, markdown) |
| `--output <file>` | Write result to file |
| `--skip-research` | Skip the research pre-pass |

## `translate`

[src/application/translate-task.ts](../../implementation/src/application/translate-task.ts). Translates / localizes a target. Inputs:

- `--what <path>` — source content.
- `--how <path>` — translation instructions / glossary.
- `--output <path>` — destination.

Used internally by `localize-project` and `init`'s locale flow. Available as a top-level command since migration 134 / 138.
