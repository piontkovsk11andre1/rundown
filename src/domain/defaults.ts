/**
 * Built-in default templates.
 *
 * Used when a project does not provide .rundown/ templates.
 *
 * Layout principle: templates are structured for KV-cache efficiency.
 * Every default template starts with the exact same prefix.
 * The raw document context appears first with no phase-specific text before it.
 * That allows execute, verify, repair, and plan prompts for the same task
 * to reuse the same cache prefix before diverging.
 */

const DEFAULT_TEMPLATE_SHARED_PREFIX = `\
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

\`{{file}}\` (line {{taskLine}})

## Selected task

{{task}}
`;

export const DEFAULT_TASK_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Execute the selected task.

Complete the task described above. Make the necessary changes to the project, but do not edit the source Markdown task file as part of completion tracking.

- Do not change the checkbox in the source Markdown file.
- Do not rewrite the task item to make it look completed.
- Do not treat editing the TODO file itself as evidence that the task is done unless the task explicitly requires documentation changes in that file.
- rundown is responsible for marking the task complete after validation succeeds.
`;

export const DEFAULT_VALIDATE_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Verify whether the selected task is complete.

Evaluate whether the task above has been completed.

Write your result to a file named \`{{file}}.{{taskIndex}}.validation\` next to the source file.

- If the task is complete, write exactly: OK
- If the task is not complete, write a short explanation of what is still missing.

Do not modify the source Markdown task file or change its checkbox state. Validation is determined only by the actual project state and the sidecar file above.

Do not write anything else.
`;

export const DEFAULT_CORRECT_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Repair the selected task after a failed verification pass.

## Previous validation result

{{validationResult}}

Please fix what is missing or incorrect. The validation above explains what still needs to be done.

- Do not change the checkbox in the source Markdown file.
- Do not mark the task complete yourself.
- rundown will update task completion only after validation succeeds.

After making corrections, the task will be validated again.
`;

export const DEFAULT_VARS_FILE_CONTENT = `{
	"branch": "main",
	"ticket": "ENG-42"
}
`;

export const DEFAULT_PLAN_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Plan the selected task by decomposing it into concrete subtasks.

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
