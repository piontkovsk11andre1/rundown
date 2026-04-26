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

Handler in [src/domain/builtin-tools/force.ts](../../implementation/src/domain/builtin-tools/force.ts).

Registration:

```ts
{ kind: "modifier", handler: forceHandler }
```

- Sets the iteration intent to `fast-execution`: `repair-attempts` is forced to 0.
- Verification still runs (if otherwise scheduled), but a verification failure does not retry — it produces `task.failed`.
- Useful for best-effort cleanup tasks, observation-only checks, or commands where retry would be harmful (idempotent destructive operations).

## Stacking

Modifiers compose with handlers and with each other:

```markdown
- [ ] profile=fast force: verify: lint clean
```

Resolution:

1. `profile=fast` — modifier, sets the active profile to `fast`.
2. `force:` — modifier, sets the intent to `fast-execution`.
3. `verify:` — handler, runs verification with the modifications above.

The order between two modifiers is irrelevant. A modifier after a handler is a syntax error (handler "wins" and consumes the rest of the prefix chain as text).

## Trace

Modifier effects are recorded in `task.context` events: the resolved profile, repair-attempts cap, and any health-policy interactions are visible in the trace without re-deriving them from prefix tokens.
