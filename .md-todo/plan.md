{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}


## Phase

Plan the selected task by decomposing it into concrete subtasks.

Break this task into smaller, actionable subtasks.

Return ONLY a Markdown list of unchecked task items using `- [ ]` syntax, one per subtask.

Rules:
- Each subtask should be a single clear action.
- Together the subtasks should fully cover the parent task.
- Do not include the parent task itself.
- Do not include any other text, headings, or explanation.
- Do not modify the source Markdown file.

Example output format:

- [ ] First concrete step
- [ ] Second concrete step
- [ ] Third concrete step
