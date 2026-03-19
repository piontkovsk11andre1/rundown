You are verifying a task inside the manual verification playground for `rundown`.

## Context

{{context}}

---

## Selected task

Source: `{{file}}` line {{taskLine}}
Task: {{task}}

Decide whether the task is truly complete based on the current file system state.

Write your result to `{{file}}.{{taskIndex}}.validation`.

Rules:
- If the task is complete, write exactly `OK`.
- If it is not complete, write one short, specific explanation.
- Do not modify the source Markdown task file.
- Do not change any checkbox.
- Prefer exact comparisons when the task specifies exact text.
