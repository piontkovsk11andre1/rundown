# `optional:` / `skip:` and terminal control

Handlers in [src/domain/builtin-tools/end.ts](../../implementation/src/domain/builtin-tools/end.ts).

## `optional:` and `skip:`

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: false, shouldVerify: false } }
```

These are **conditional control-flow** prefixes:

- The worker is invoked once with the task body.
- Its stdout is interpreted as a yes/no condition (handler-defined parsing).
- If the condition is true, the rest of the task runs; if false, the task completes as `[x]` immediately without further execution and the loop moves on.

`optional:` and `skip:` are aliases of each other but read differently in prose. They register against the same handler.

## Terminal handlers — `end:` / `exit:` / `return:` / `quit:` / `break:`

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: false, shouldVerify: false } }
```

- The worker is invoked (so the document author can supply a reason).
- After the worker returns, the **outer loop terminates**.
- `end:` / `exit:` / `return:` / `quit:` end the entire run.
- `break:` ends the current loop only — the next outer task continues. This is the early-exit primitive for `migrate` and similar loop-y commands (see migration 111).

All five names are registered for compatibility:

| Name | Status |
|---|---|
| `end:` | canonical |
| `exit:` | alias |
| `return:` | alias |
| `quit:` | retained for compatibility (policy) |
| `break:` | distinct semantics: loop-local exit |

## Why these are handlers, not modifiers

Terminal control affects the surrounding loop, not just one task. A modifier wouldn't be able to short-circuit dispatch. By making them handlers with `skipExecution: false`, the document author can author a meaningful prompt — e.g. "explain why we're stopping" — that becomes part of the trace.

## Trace events

Terminal handlers emit `run.completed` with status `completed` (graceful) and a payload reason taken from the worker output. `break:` emits `task.completed` plus a loop-control marker.
