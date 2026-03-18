/**
 * Built-in default templates.
 *
 * Used when a project does not provide .md-todo/ templates.
 *
 * Layout principle: templates are structured for KV-cache efficiency.
 * Large, stable content (document context) appears first so that
 * consecutive tasks in the same file share a long common prefix.
 * Per-task variables (task text, line number, validation result)
 * appear after the context block.
 */

export const DEFAULT_TASK_TEMPLATE = `\
You are working on a project. A Markdown TODO has been selected for you to complete.

## Document context

The following is the content of the Markdown file up to the point of this task:

---

{{context}}

---

## Source file

\`{{file}}\` (line {{taskLine}})

## Task

{{task}}

Complete the task described above. Make the necessary changes to the project, but do not edit the source Markdown task file as part of completion tracking.

- Do not change the checkbox in the source Markdown file.
- Do not rewrite the task item to make it look completed.
- Do not treat editing the TODO file itself as evidence that the task is done unless the task explicitly requires documentation changes in that file.
- md-todo is responsible for marking the task complete after validation succeeds.
`;

export const DEFAULT_VALIDATE_TEMPLATE = `\
A task was just executed. Your job is to validate whether it was completed successfully.

## Document context

{{context}}

---

## Source file

\`{{file}}\` (line {{taskLine}})

## Task

{{task}}

Evaluate whether the task above has been completed.

Write your result to a file named \`{{file}}.{{taskIndex}}.validation\` next to the source file.

- If the task is complete, write exactly: OK
- If the task is not complete, write a short explanation of what is still missing.

Do not modify the source Markdown task file or change its checkbox state. Validation is determined only by the actual project state and the sidecar file above.

Do not write anything else.
`;

export const DEFAULT_CORRECT_TEMPLATE = `\
A task was executed but validation determined it is not yet complete.

## Document context

{{context}}

---

## Source file

\`{{file}}\` (line {{taskLine}})

## Task

{{task}}

## Previous validation result

{{validationResult}}

Please fix what is missing or incorrect. The validation above explains what still needs to be done.

- Do not change the checkbox in the source Markdown file.
- Do not mark the task complete yourself.
- md-todo will update task completion only after validation succeeds.

After making corrections, the task will be validated again.
`;

export const DEFAULT_VARS_FILE_CONTENT = `{
	"branch": "main",
	"ticket": "ENG-42"
}
`;

export const DEFAULT_PLAN_TEMPLATE = `\
A Markdown TODO has been selected for planning. Your job is to decompose it into concrete subtasks.

## Document context

The following is the content of the Markdown file up to the point of this task:

---

{{context}}

---

## Source file

\`{{file}}\` (line {{taskLine}})

## Task to plan

{{task}}

Break this task into smaller, actionable subtasks.

Return ONLY a Markdown list of unchecked task items using \`- [ ]\` syntax, one per subtask.

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
`;
