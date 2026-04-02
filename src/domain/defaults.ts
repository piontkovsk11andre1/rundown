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

// Shared preamble reused by all default prompt templates.
const DEFAULT_TEMPLATE_SHARED_PREFIX = `\
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

\`{{file}}\` (line {{taskLine}})

## Selected task

{{task}}
`;

/**
 * Appends trace-output instructions to a template when tracing is enabled.
 *
 * The block defines a strict fenced format that downstream parsing expects.
 */
export const TRACE_INSTRUCTIONS_BLOCK = `\

## Trace output

Tracing is active for this run.

At the end of your response, append exactly one fenced block in this format:

\`\`\`rundown-trace
confidence: <0-100>
files_read: <comma-separated list or "none">
files_written: <comma-separated list or "none">
tools_used: <comma-separated list or "none">
approach: <one-line summary>
blockers: <issues or "none">
\`\`\`

Keep values short and concrete.
`;

/**
 * Returns the trace instructions block when tracing is enabled.
 *
 * @param trace Whether trace output should be requested from the agent.
 * @returns Trace instructions text or an empty string.
 */
export function getTraceInstructions(trace: boolean): string {
  return trace ? TRACE_INSTRUCTIONS_BLOCK : "";
}

/**
 * Default execute-phase prompt template used to run a selected task.
 */
export const DEFAULT_TASK_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Execute the selected task.

Complete the task described above. Make the necessary changes to the project, but do not edit the source Markdown task file as part of completion tracking.

- Do not change the checkbox in the source Markdown file.
- Do not rewrite the task item to make it look completed.
- Do not treat editing the TODO file itself as evidence that the task is done unless the task explicitly requires documentation changes in that file.
- rundown is responsible for marking the task complete after validation succeeds.
{{traceInstructions}}
`;

/**
 * Default discuss-phase prompt template used to refine task scope before implementation.
 */
export const DEFAULT_DISCUSS_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Discuss and refine the selected task before execution.

Use this session to help the user shape the task into a clear, executable outcome.

You may modify the source Markdown task text as part of discussion when it helps:

- rewrite unclear task wording
- split a broad task into smaller actionable items
- add sub-items to capture concrete steps
- clarify scope, assumptions, constraints, or acceptance criteria

## Task context

Use the full task context below when refining scope.

### Task hierarchy

Children:
{{children}}

Sub-items:
{{subItems}}

### Source snapshot

{{source}}

Rules:
- collaborate with the user; confirm intent when needed
- keep edits focused on improving task clarity and executability
- do not mark tasks complete or change checkbox state
- do not perform implementation work in this phase
`;

/**
 * Default verify-phase prompt template used to validate task completion.
 */
export const DEFAULT_VERIFY_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Verify whether the selected task is complete.

Evaluate whether the task above has been completed.

Return your verification result on stdout as exactly one of the following:

- \`OK\`
- \`NOT_OK: <short explanation of what is still missing>\`

Do not create or modify validation files directly. rundown will persist your stdout result in run artifacts for use by subsequent repair and trace steps.

Do not modify the source Markdown task file or change its checkbox state.

Do not write anything else.
{{traceInstructions}}
`;

/**
 * Default repair-phase prompt template used after a failed verification result.
 */
export const DEFAULT_REPAIR_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Repair the selected task after a failed verification pass.

## Previous validation result

{{verificationResult}}

Please fix what is missing or incorrect. The validation above explains what still needs to be done.

- Do not change the checkbox in the source Markdown file.
- Do not mark the task complete yourself.
- rundown will update task completion only after validation succeeds.

After making corrections, the task will be validated again.
{{traceInstructions}}
`;

/**
 * Default contents for the generated variables file.
 */
export const DEFAULT_VARS_FILE_CONTENT = `{}
`;

/**
 * Default contents for the generated rundown config file.
 */
export const DEFAULT_CONFIG_CONTENT = `{}
`;

/**
 * Default plan-phase prompt template used to propose missing additive TODO items.
 */
export const DEFAULT_PLAN_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Plan full-document implementation coverage as additive TODO candidates.

Analyze the entire Markdown document and identify only actionable TODO items that are still missing.

Return ONLY a Markdown list of unchecked task items using \`- [ ]\` syntax, one per missing TODO to add.

Rules:
- Cover the document's implementation intent end-to-end; include only executable actions.
- Each TODO should be a single clear action and specific enough to implement directly.
- Only propose additive TODO candidates that are not already present.
- Do not rewrite, reorder, delete, or mark existing TODO items as complete.
- Do not include any other text, headings, or explanation.
- Do not modify the source Markdown file.

Example output format:

- [ ] First concrete step
- [ ] Second concrete step
- [ ] Third concrete step
{{traceInstructions}}
`;

/**
 * Default trace-phase prompt template used to produce an analysis.summary payload.
 */
export const DEFAULT_TRACE_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}

## Phase

Analyze this completed run and produce an \`analysis.summary\` event payload.

## Run context

- Run ID: {{runId}}
- Command: {{command}}
- Status: {{status}}
- Worker: {{worker}}
- Started at: {{startedAt}}
- Completed at: {{completedAt}}
- Total duration (ms): {{totalDurationMs}}

## Phase timings

{{phaseTimings}}

## Phase outputs

{{phaseOutputs}}

## Agent signals

{{agentSignals}}

## Thinking blocks

{{thinkingBlocks}}

## Tool usage

{{toolUsage}}

Return exactly one fenced code block tagged \`analysis.summary\` containing valid JSON only.
Do not include any text before or after the fenced block.

Required JSON shape:

\`\`\`analysis.summary
{
  "task_complexity": "low | medium | high | critical",
  "execution_quality": "clean | minor_issues | significant_issues | failed",
  "direction_changes": 0,
  "modules_touched": ["module/or/area"],
  "wasted_effort_pct": 0,
  "key_decisions": ["decision"],
  "risk_flags": ["risk"],
  "improvement_suggestions": ["suggestion"],
  "skill_gaps": ["gap"],
  "thinking_quality": "clear | scattered | circular",
  "uncertainty_moments": 0
}
\`\`\`

Rules:
- Base the analysis on the provided run context only.
- Keep arrays concise and concrete.
- Use empty arrays when there is no relevant data.
- Use non-negative integers for \`direction_changes\`, \`wasted_effort_pct\`, and \`uncertainty_moments\`.
`;

