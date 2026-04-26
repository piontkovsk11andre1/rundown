# Planning, research, and scaffolding commands

Worker invocations that **don't** flip checkboxes; they produce or transform content. The bootstrap variants (`add`, `make`, `do`) chain plan/research with file scaffolding.

## `plan <source>`

Scan-based TODO generator. Implementation: [src/application/plan-task.ts](../../implementation/src/application/plan-task.ts).

| Option | Effect |
|---|---|
| `--scan-count <n>` | Cap independent scans (omit for convergence-driven unlimited mode) |
| `--max-items <n>` | Cap added items across all scans |
| `--deep <n>` | Additional nested planning depth passes after top-level scans |
| `--loop` | Use the loop-planning template (`.rundown/plan-loop.md`) |
| `--mode <mode>` | Planner mode (currently `wait`) |
| `--dry-run` | Validate planner output without writing |
| `--print-prompt` | Print prompt without running |
| `--worker <pattern>` | Override worker |

**Additive-only contract**: planner output may only contain unchecked `- [ ]` lines; rundown rejects any non-additive change (toggling completion, removing items, reordering). Insertion strategy:

- existing TODOs in source → append after the last TODO line,
- no existing TODOs → append at end of document.

Convergence: the loop ends when a scan adds zero new items, or when `--scan-count` is reached.

## `add <seed-text> <markdown-file>`

[src/application/run-task.ts](../../implementation/src/application/run-task.ts) + [plan-task.ts](../../implementation/src/application/plan-task.ts) wired together.

Appends the literal seed text to an existing Markdown file, then runs `plan` against the result. Use it to extend an in-progress task doc with new context-driven items without leaving the CLI.

## `make <seed-text> <markdown-file>`

Creates a brand-new Markdown task doc from seed text, then runs `research` and `plan` against it. The default flow is research-then-plan; `--skip-research` (alias `--raw`) skips the research phase.

## `research <source>`

Research-oriented worker invocation. Produces output without executing tasks. The output may be saved to memory or written to a target file.

## `explore <source>`

Combined plan + research pass. Useful for "throw a directory at it and tell me what's there".

## `query <text>`

Non-interactive natural-language query. Internally orchestrates a research → plan → execute pipeline against the working directory and returns a single answer.

| Option | Effect |
|---|---|
| `--dir <path>` | Target directory to analyze (default cwd) |
| `--format <fmt>` | `markdown` (default), `json`, `yn`, `success-error` |
| `--output <file>` | Write final result to file |
| `--skip-research` | Skip the research pre-pass |

Compared to `discuss`, `query` is non-interactive and stateless.

## `translate <what> <how> <output>`

[src/application/translate-task.ts](../../implementation/src/application/translate-task.ts). Re-expresses the `<what>` Markdown document using the vocabulary defined by the `<how>` reference, writing the result to `<output>`.

Used internally by `localize` and `init`'s locale flow. Available as a top-level command since migration 134 / 138.

