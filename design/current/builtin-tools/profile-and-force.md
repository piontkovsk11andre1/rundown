# `profile=name` and `force:`

The two **modifiers** in the built-in registry. Both attach metadata to the iteration without owning dispatch.

## `profile=name`

Handler in [src/domain/builtin-tools/profile.ts](../../implementation/src/domain/builtin-tools/profile.ts).

Registration:

```ts
{ kind: "modifier", handler: profileHandler }
```

- Looks up `profiles.<name>` in the merged config and applies it as the resolved worker for *this iteration only*.
- Valid placement:
  - file-level frontmatter (`profile: name`),
  - directive parent list item (`- profile=name` with checkbox children),
  - task sub-item (`profile=name` under a checkbox) — **only respected for `verify-only` and `memory-capture` intents**. For other intents a warning is emitted: "profile not supported on sub-items for this intent".
- Unknown profile names produce: `Unknown worker profile: <name>` and the task fails.

## `force:`

Handler in [src/domain/builtin-tools/force.ts](../../implementation/src/domain/builtin-tools/force.ts). Extraction logic in [src/domain/prefix-chain.ts](../../implementation/src/domain/prefix-chain.ts) (`extractForceModifier`).

Registration:

```ts
{ kind: "modifier", handler: forceHandler }
```

- Wraps the iteration in a **top-level retry loop**. Default cap: 2 attempts. Explicit cap with `force: N, <task text>` (the comma is required — without it `force: 3` is treated as task text).
- Each attempt is a full execute → verify → (repair) cycle. Retry-boundary git checkpoints (stash + restore) are taken between attempts when commit mode is active so failed attempts do not leave dirty state.
- A successful attempt short-circuits the loop and the task is checked.
- Useful when a task is flaky in a recoverable way and a clean retry from scratch is more reliable than the inner repair loop.
- `force:` does **not** set the `fast-execution` intent and does **not** disable the inner repair loop — the repair loop still runs inside each attempt.

## Stacking

Modifiers compose with handlers and with each other:

```markdown
- [ ] profile=fast force: verify: lint clean
```

Resolution:

1. `profile=fast` — modifier, sets the active profile to `fast`.
2. `force:` — modifier, wraps the iteration in a top-level retry loop (default 2 attempts).
3. `verify:` — handler, runs verification with the modifications above.

The order between two modifiers is irrelevant. A modifier after a handler is a syntax error (handler "wins" and consumes the rest of the prefix chain as text).

## Trace

Modifier effects are recorded in `task.context` events: the resolved profile, repair-attempts cap, and any health-policy interactions are visible in the trace without re-deriving them from prefix tokens.
