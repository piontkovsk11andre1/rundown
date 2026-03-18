{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}


## Phase

Verify whether the selected task is complete.

Evaluate whether the task above has been completed.

Write your result to a file named `{{file}}.{{taskIndex}}.validation` next to the source file.

- If the task is complete, write exactly: OK
- If the task is not complete, write a short explanation of what is still missing.

Do not modify the source Markdown task file or change its checkbox state. Validation is determined only by the actual project state and the sidecar file above.

Do not write anything else.
