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

// Shared compact memory metadata block for worker-facing prompts.
const DEFAULT_TEMPLATE_MEMORY_SECTION = `\

## Memory context

- Status: {{memoryStatus}}
- File: \`{{memoryFilePath}}\`
- Index: \`{{memoryIndexPath}}\`
- Summary: {{memorySummary}}

Memory map:

\`\`\`json
{{memoryMap}}
\`\`\`
`;

// Shared user-provided template variables block for worker-facing prompts.
export const DEFAULT_TEMPLATE_VARS_SECTION = `\

## Variables

{{userVariables}}
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
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

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
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

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
 * Default discuss-finished template used to analyze a completed run in TUI.
 */
export const DEFAULT_DISCUSS_FINISHED_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Discuss a finished task run using saved run artifacts.

Use this session to help the user understand what was implemented, what failed,
what was repaired, and why outcomes occurred.

## Finished run context

- Run ID: {{runId}}
- Run status: {{runStatus}}
- Run directory: {{runDir}}
- Task text: {{taskText}}
- Task file: {{taskFile}}
- Task line: {{taskLine}}
- Commit SHA: {{commitSha}}

## Phase summary

{{phaseSummary}}

## Missing log notes

{{missingLogsSummary}}

## Phase directory paths

- Execution phase directory: {{executionPhaseDir}}
- Verify phase directories:
{{verifyPhaseDirs}}
- Repair phase directories:
{{repairPhaseDirs}}

## Required reading

Read these artifacts before discussing outcomes:

1. Execution phase artifacts, especially \`prompt.md\`, \`stdout.log\`, and
   \`stderr.log\` when present.
2. Every verify phase directory, including each \`metadata.json\` to confirm
   verification verdicts and reasons.
3. Every repair phase directory to understand each repair attempt and its
   result.

If any log files are missing, treat them as not captured and state that
explicitly in your discussion.

Be ready to discuss:

- what changed and was implemented
- why verification passed or failed
- what repairs were attempted and their outcomes
- unresolved issues, risks, and follow-up suggestions

Do not change checkbox state in the source Markdown file.
`;

/**
 * Default help-session prompt template used for no-argument CLI live help.
 */
export const DEFAULT_HELP_TEMPLATE = `\
## Rundown live help

- CLI version: {{cliVersion}}
- Working directory: {{workingDirectory}}

## Command index

{{commandIndex}}

## Repository docs context

{{docsContext}}

## Guidance

- Help the user choose the right command and flags for their goal.
- Ask follow-up questions before suggesting risky or destructive actions.
- Keep answers grounded in this repository context and available commands.
`;

/**
 * Default verify-phase prompt template used to validate task completion.
 */
export const DEFAULT_VERIFY_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Verify whether the selected task is complete.

Evaluate whether the task above has been completed.

Your ENTIRE stdout output must be exactly one line containing only the verdict.
Do not include any explanatory text, reasoning, or preamble before the verdict.

Return your verification result on stdout as exactly one of the following:

- \`OK\`
- \`NOT_OK: <short explanation of what is still missing>\`

Output ONLY the verdict line — nothing else. Any extra output degrades verification reliability.

Do not create or modify validation files directly. rundown will persist your stdout result in run artifacts for use by subsequent repair and trace steps.

Do not modify the source Markdown task file or change its checkbox state.
{{traceInstructions}}
`;

/**
 * Default repair-phase prompt template used after a failed verification result.
 */
export const DEFAULT_REPAIR_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

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
${DEFAULT_TEMPLATE_MEMORY_SECTION}

## Phase

Edit the source Markdown file directly to improve plan coverage.

Review \`{{file}}\` and insert missing actionable TODO items in logical locations.

Rules:
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Insert new items where they fit best; you may add them in the middle of existing lists.
- You may reorder unchecked \`- [ ]\` items when it improves execution flow.
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove, rewrite, or move any completed \`- [x]\` item.
- Do not output a proposed list on stdout; apply edits to \`{{file}}\` directly.
{{traceInstructions}}
`;

/**
 * Default deep-plan prompt template used to directly edit missing child TODO
 * items for a single parent task.
 */
export const DEFAULT_DEEP_PLAN_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}

## Parent task context

- Parent task: {{parentTask}}
- Parent line: {{parentTaskLine}}
- Parent depth: {{parentTaskDepth}}

## Phase

Edit the source Markdown file directly to improve child plan coverage for the parent task above.

Review \`{{file}}\` and add missing unchecked child TODO items under this parent task.

Rules:
- Scope changes strictly to child TODO items under the selected parent task.
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Insert new child items where they fit best under the parent; you may reorder unchecked child \`- [ ]\` items when it improves execution flow.
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove, rewrite, or move any completed \`- [x]\` item.
- Do not output a proposed list on stdout; apply edits to \`{{file}}\` directly.
{{traceInstructions}}
`;

/**
 * Default research-phase prompt template used to enrich a source document with
 * implementation context before planning.
 */
export const DEFAULT_RESEARCH_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}

## Full document

{{source}}

## Phase

Research and enrich the source document with implementation context.

Read the full document above and enrich it with the context, background, and
structural detail needed for a planning agent to later propose concrete TODO
items.

Your output replaces the document body. Write the complete updated Markdown
document.

Guidelines:

- Expand thin descriptions into clear feature specifications.
- Add relevant technical context: existing code patterns, module boundaries,
  API surfaces, and conventions discovered via CLI blocks or project knowledge.
- Surface design constraints, edge cases, and compatibility considerations.
- Propose document structure: add section headings, acceptance criteria
  outlines, scope/out-of-scope boundaries, and integration notes.
- Preserve everything the author already wrote - do not remove or contradict
  existing content, only augment it.
- Do NOT add TODO items (\`- [ ]\` lines). Task decomposition is a separate
  phase.
- Do NOT change any checkbox state in the document.
- Do NOT add implementation code. This phase is about context and planning
  guidance, not execution.
- Write in the same voice and style as the existing document.

Return the full updated Markdown document and nothing else.
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

