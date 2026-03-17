/**
 * Built-in default templates.
 *
 * Used when a project does not provide .md-todo/ templates.
 */

export const DEFAULT_TASK_TEMPLATE = `\
You are working on a project. A Markdown TODO has been selected for you to complete.

## Task

{{task}}

## Source file

\`{{file}}\` (line {{taskLine}})

## Document context

The following is the content of the Markdown file up to the point of this task:

---

{{context}}

---

Complete the task described above. Make the necessary changes to the project.
`;

export const DEFAULT_VALIDATE_TEMPLATE = `\
A task was just executed. Your job is to validate whether it was completed successfully.

## Task

{{task}}

## Source file

\`{{file}}\` (line {{taskLine}})

## Document context

{{context}}

---

Evaluate whether the task above has been completed.

Write your result to a file named \`{{file}}.{{taskIndex}}.validation\` next to the source file.

- If the task is complete, write exactly: OK
- If the task is not complete, write a short explanation of what is still missing.

Do not write anything else.
`;

export const DEFAULT_CORRECT_TEMPLATE = `\
A task was executed but validation determined it is not yet complete.

## Task

{{task}}

## Source file

\`{{file}}\` (line {{taskLine}})

## Previous validation result

{{validationResult}}

## Document context

{{context}}

---

Please fix what is missing or incorrect. The validation above explains what still needs to be done.

After making corrections, the task will be validated again.
`;

export const DEFAULT_VARS_FILE_CONTENT = `{
	"branch": "main",
	"ticket": "ENG-42"
}
`;
