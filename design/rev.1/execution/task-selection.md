# Task selection

[src/domain/task-selection.ts](../../implementation/src/domain/task-selection.ts) implements the canonical "what runs next" decision. The infrastructure adapter [src/infrastructure/selector.ts](../../implementation/src/infrastructure/selector.ts) wires it to `TaskSelectorPort`.

## Rules

1. **Depth-first.** The first unchecked task in pre-order traversal of the task tree wins.
2. **Hierarchy gate.** A task is only runnable if all its checked-or-not ancestors satisfy the gate: every ancestor checkbox must already be `[x]`. If a parent is `[ ]`, its children are not runnable yet — that parent runs first.
3. **No sibling dependency.** The framework does not infer dependencies between siblings. Order is purely document order.
4. **Multi-source ordering.** When `source` resolves to several files, files are ordered per `--sort` (defaults to `name-sort`). Other modes: `none`, `old-first`, `new-first`. Aliases like `created` or `newest` are explicitly **not** supported (see repo memory note in [src/presentation/cli.ts](../../implementation/src/presentation/cli.ts)).
5. **`--all` semantics.** Without `--all`, `run` selects exactly one task and returns. With `--all`, the loop continues until no runnable unchecked task remains.
6. **Multi-round (`--rounds N`).** Rounds run the full pass `N` times sequentially. Each round re-parses the source and re-selects from scratch.

## Determinism

- Selection is a pure function of the source's bytes plus sort mode.
- Re-running with the same input always produces the same task ordering.
- This determinism is what makes `materialize` and `test --future` reproducible.

## Why not graph-based dependencies

- Markdown lists are already a tree; the tree is the dependency graph.
- Cross-file or cross-section dependencies are expressed via `include:` (which delegates to a nested rundown over a cloned file). The parent task only completes when the included rundown completes — that is the dependency.
- Avoiding a separate dependency syntax keeps Markdown the single source of truth.

## Edge cases

- **Empty source**: returns null; the run completes successfully with zero tasks.
- **Already-checked source**: returns null; same as empty.
- **Lock contention**: the source-level `FileLock` is acquired before selection. If acquisition fails the run aborts with a lock-held error.
- **Mid-run mutations**: workers should not mutate the source file directly (see [../workers/execution-modes.md](../workers/execution-modes.md)). Verification re-reads the source from disk; if the checkbox state changed underneath, behavior is per the verification contract.
