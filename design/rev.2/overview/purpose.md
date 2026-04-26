# Purpose

`rundown` is a **Markdown-native task runtime and future-prediction framework for agentic workflows**. It serves two layers of need with the same primitives.

## Lowest level — workload protocol

A Markdown file with GFM checkbox tasks is treated as an executable program. The runtime:

1. Parses the file into a task tree.
2. Selects the next runnable unchecked task (depth-first, hierarchy-respecting).
3. Builds a structured prompt from the surrounding document context.
4. Hands the prompt to a worker process (an external agent CLI: opencode, claude, gemini, codex, aider, cursor, …) or executes an inline `cli:` block.
5. Verifies the result (separate worker invocation or inline verification).
6. Repairs and re-verifies on failure, with bounded attempts.
7. **Only then** flips the checkbox to `[x]`.

The checkbox is a *consequence* of verified work, not a guess.

## Highest level — prediction loop

The same checkbox protocol is the substrate for a prediction-driven workflow:

- Living design documents in [design/current/](../../design/current/) describe intent.
- `rd design release` snapshots that intent into immutable `design/rev.N/` revisions.
- `rundown migrate` runs a planner-driven convergence loop that proposes, creates and executes migration files until it reports `DONE`.
- `rundown materialize` executes a migration's tasks against the real implementation.
- `rundown test` verifies assertion specs against either the materialized state or a *predicted* state derived from snapshots + pending migrations.

This makes the migration track a deterministic bridge between *what we want* (design) and *what exists* (implementation).

## Executables

The package ships a single binary published under two names:

- `rundown` — canonical CLI name.
- `rd` — strict alias, identical behavior.

Both are declared in [implementation/package.json](../../implementation/package.json) under `bin`.

## What `rundown` is not

- Not a build system. It does not understand language toolchains, only Markdown and worker processes.
- Not a parallel scheduler. Execution is strictly sequential within a file (see [../execution/task-selection.md](../execution/task-selection.md)). The `parallel:` tool dispatches groups of inline `cli:` blocks but does not introduce inter-task parallelism.
- Not opinionated about which AI agent you use. Workers are resolved through configuration; the framework only specifies the protocol they must satisfy.
