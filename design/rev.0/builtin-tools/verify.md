# `verify:` / `confirm:` / `check:`

Handler in [src/domain/builtin-tools/verify.ts](../../implementation/src/domain/builtin-tools/verify.ts).

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: true, shouldVerify: true } }
```

## Behavior

- Skips the worker-execute phase entirely.
- Runs the verification phase using the configured `verify` worker (or routing entry, if any).
- The verification worker receives a prompt rendered from the verify template plus the task's context (text, sub-items, document context, frontmatter).
- Worker stdout decides outcome:
  - `OK` (case-insensitive variants normalized) → task completes.
  - anything else → repair loop applies (or, if `force:` wraps the task, the iteration is retried from scratch up to the `force:` cap).

## When to use

- Quality gates that re-run a check without performing work.
- Asserting external state ("API returned 200", "tests pass on CI").
- Spec assertions in `test`/`test --future` flows.

## Aliases

`confirm:` and `check:` are exact aliases of `verify:`. They produce the same dispatch and exist for prose readability.

## Profiles

`profile=name` modifier is supported here (verify-only intent). The named profile overrides the worker for this single verification call. This is useful when most verifications run on a fast model but a particular spec needs a heavier one.

## Sub-items

Sub-items under a `verify:` task are interpreted as additional context for the verification prompt. They are not separate tasks.

```markdown
- [ ] verify: API responds correctly
  - URL: https://example.com/api
  - Expected: 200 OK with non-empty JSON body
```

The sub-item bullets are appended to the rendered prompt under a "context" header.
