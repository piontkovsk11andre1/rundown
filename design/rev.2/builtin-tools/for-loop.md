# `for:` / `each:` / `foreach:`

Handler in [src/domain/builtin-tools/for-loop.ts](../../implementation/src/domain/builtin-tools/for-loop.ts). Domain model in [src/domain/for-loop.ts](../../implementation/src/domain/for-loop.ts).

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false } }
```

## Behavior

- The task body declares an iteration source (a glob, a list expression, or a worker call that produces items).
- For each item, rundown runs the **child** checkbox tasks once with the item bound as a template variable (typically `$item`).
- The parent `for:` checkbox is checked **only after all iterations have completed successfully**. (Repo policy decision; see migration 109.)
- `for:` uses `autoComplete: true` because the handler manages the completion lifecycle.

## Item sources

The body of the `for:` task is interpreted depending on form:

- inline list — `for: each modified file in src/`
- explicit glob — sub-item like `glob: src/**/*.ts`
- worker-produced list — a sub-item invocation that returns a list, captured via `get:` semantics

The exact parsing rules live in [src/domain/for-loop.ts](../../implementation/src/domain/for-loop.ts).

## Iteration semantics

- Iterations run **sequentially** (no parallelism).
- Per-iteration artifacts are written under `<run-dir>/<seq>-execute/<iter-N>/` so each iteration's prompt and output are inspectable.
- Failure in iteration `k`:
  - halts the loop,
  - `for:` parent stays unchecked,
  - already-completed child checkboxes for iterations 1..k-1 stay checked (the loop tracks per-iteration state via child task state).

## Escaping

`for-item` and `get:` results are escaped before substitution into prompts to avoid breaking Markdown structure. Tracking issue: migration 108 covered escaping subtleties; see also `template-vars.ts`.

## Output flow

When the loop is done, rundown updates the parent checkbox (per `autoComplete`), emits `task.completed`, and the outer iteration moves on.
