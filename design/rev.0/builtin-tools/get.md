# `get:`

Handler in [src/domain/builtin-tools/get.ts](../../implementation/src/domain/builtin-tools/get.ts).

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: true, shouldVerify: false } }
```

## Behavior

- Runs the worker-execute phase against the task body (or sub-items) with a special prompt that asks the worker to **extract a value** rather than perform work.
- The result (worker stdout) is captured into a named template variable in the iteration context.
- Subsequent tasks in the same source can reference the captured variable in their prompts.
- The `get:` task is auto-completed; no verification.

## Naming

The variable name is taken from a `name=...` sub-item or from the first whitespace-delimited token after `get:` (handler-specific parsing).

```markdown
- [ ] get: branch
  - From: current git status
  - As: $branch
- [ ] verify: $branch starts with "feature/"
```

## Aliases

The registry deliberately registers only the canonical `get:` prefix — short aliases like `g:` are avoided to reduce collisions with project-level tool names.

## Escaping

Captured values flow into subsequent prompts after escaping (Markdown safety). See migration 108 — escaping for `for-item` and `get:` results was tightened to avoid breaking enclosing structures.

## Persistence

Captured variables are scoped to the current run; they do not persist across runs. To persist, use `memory:` instead.
