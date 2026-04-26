# Frontmatter and directives

Two locations let users override worker selection and other per-source behavior without touching the global config: YAML frontmatter at the top of a Markdown source, and directive list items inside the body.

## YAML frontmatter

Recognized at the very top of a Markdown source. Schema (rundown-relevant subset):

```yaml
---
profile: fast                 # file-level default profile name
locale: ru                    # override locale for messages

rundown:
  profiles:
    local-model:              # file-local profile (does not bleed into config.json)
      - opencode
      - run
      - --file
      - "$file"
      - --model
      - localhost/gpt
---
```

| Key | Behavior |
|---|---|
| `profile` | File-level default. Used by all checkbox tasks unless overridden by directive or task-level. |
| `rundown.profiles.<name>` | Local profile definition. Visible only inside this file. |
| `locale` | File-level locale; the message catalog is selected accordingly. |

Frontmatter that is not under a key understood by rundown is left untouched and ignored.

## Directive list items

A list item with **no** checkbox that is a parent of one or more checkbox children acts as a directive scope:

```markdown
- profile=thinking
  - [ ] task A
  - [ ] task B
```

This is equivalent to placing `profile=thinking` as a sub-item under each child. Directives are recognized by [src/domain/parser.ts](../../implementation/src/domain/parser.ts) and the resulting `directiveProfile` is attached to each child task.

Directives may also stack tool prefixes:

```markdown
- profile=fast force:
  - [ ] verify: spec X holds
  - [ ] verify: spec Y holds
```

Both children inherit `profile=fast` and `force:` (no repair).

## Task-level sub-items

Per-task overrides go inside a non-checkbox bullet under the task:

```markdown
- [ ] verify: spec Z
  - profile=heavy
```

Constraint: `profile=` task sub-items are only respected for `verify-only` and `memory-capture` intents. For other intents, a warning is emitted and the override is ignored. Use directives or frontmatter for those cases.

## Other recognized sub-items

- `vars-file=path.json` — load template vars from this file for the task.
- `name=...` (e.g. on `get:`) — name the captured variable.
- `URL: ...`, `Expected: ...`, etc. — free-form context lines passed into prompts.

The parser collects all sub-items into `Task.subItems`; per-prefix handlers know which sub-items they care about.
