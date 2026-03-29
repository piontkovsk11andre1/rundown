# Templates

`rundown` is template-driven.

Repository-local Markdown templates define how tasks are executed, verified, repaired, and planned.

## Template files

Store templates in `.rundown/`:

```text
.rundown/
  execute.md
  verify.md
  repair.md
  plan.md
  discuss.md
  vars.json
```

### Template files table

| File | Role |
| --- | --- |
| `.rundown/execute.md` | Instructions for doing the task |
| `.rundown/verify.md` | Instructions for deciding whether the task is truly complete |
| `.rundown/repair.md` | Instructions for fixing a failed attempt |
| `.rundown/plan.md` | Instructions for breaking a task into nested subtasks |
| `.rundown/discuss.md` | Instructions for interactive task refinement before execution |

## Why templates matter

Templates keep workflow behavior close to the repository:

- visible,
- editable,
- versioned,
- and easy to review.

That makes `rundown` feel like a reusable framework instead of a hardcoded integration.

## Prompt construction

For the built-in templates, the prompt layout is intentionally cache-friendly:

1. Markdown context from the source document comes first,
2. then the selected task metadata,
3. then the phase-specific instructions for execute, verify, repair, plan, or discuss.

The same model applies to verification, repair, planning, and discussion with their respective templates.

## Template variables

You can inject additional variables into templates.

Examples:

```bash
rundown run roadmap.md --var branch=main --var ticket=ENG-42 -- opencode run
rundown run roadmap.md --vars-file .rundown/vars.json -- opencode run
rundown run roadmap.md --vars-file -- opencode run
```

When `--vars-file` is used without a path, `rundown` loads `.rundown/vars.json`.

When both are provided, direct `--var` entries override file-loaded values.

These values are available in templates as placeholders such as `{{branch}}` or `{{ticket}}`.

## Example template content

The examples below show realistic templates you can copy into `.rundown/` and customize.

### `discuss.md`

```md
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}

## Discussion mode

You are in interactive discussion mode.

Goal:
- Help the user refine this task before execution.
- Identify ambiguity, missing constraints, and hidden assumptions.

You may modify the source Markdown file to improve task quality by:
- rewriting the selected task for clarity,
- splitting it into smaller unchecked sub-items,
- adding scoped acceptance criteria,
- tightening vague wording and out-of-date details.

Rules:
- Keep edits focused on this task and its immediate sub-items.
- Preserve Markdown structure and checklist formatting.
- Do not mark any checkbox completed.
- Do not claim implementation is finished in this mode.

Project context:
- Branch: `{{branch}}`
- Ticket: `{{ticket}}`
```

### `execute.md`

```md
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}

## Phase

Execute the selected task.

Project context:
- Branch: `{{branch}}`
- Ticket: `{{ticket}}`

Requirements:
- Implement exactly what the selected task asks for.
- Keep changes focused and production-ready.
- Do not edit the source Markdown checkbox or mark completion manually.
- Keep output concise and include file paths changed.
```

### `verify.md`

```md
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}

## Phase

Verify whether the selected task is complete.

Validation steps:
1. Check the current project state (files, tests, output) against the selected task.
2. Decide if the task is complete.

Return your result on stdout as exactly one of:

- `OK`
- `NOT_OK: <short explanation of what is still missing>`

- Do not create or modify verification artifacts directly. `rundown` persists your parsed stdout result in verify-phase runtime artifact metadata.
- Do not modify the source Markdown task file.
- Do not change any checkbox.
```

## Planning output requirements

The planner worker should return only unchecked Markdown task items.

Example:

```md
- [ ] Write the new README opening
- [ ] Add a short Windows example
- [ ] Tighten the installation section
```

`rundown` parses those items and inserts them beneath the selected parent task at one indentation level deeper.

## Verification contract

Verification is intentionally strict.

`rundown` persists the parsed verifier stdout result in verify-phase runtime artifact metadata. If that persisted result contains exactly `OK`, the task is considered complete.

Anything else means the task remains unchecked.

This keeps completion logic explicit and inspectable.
