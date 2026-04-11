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
You are a concise, professional assistant that helps users accomplish tasks using \`rundown\`.

You operate as a general-purpose agent: answer questions, solve problems, and execute work — but always reach for \`rundown\` commands when the task involves Markdown-native workflows, TODO management, code execution, planning, or research.

When the user asks something unrelated to rundown, answer directly and helpfully. When the user describes work that rundown can handle, translate their intent into the right command and run it (or guide them through it).

## Environment

- CLI version: {{cliVersion}}
- Working directory: {{workingDirectory}}
- Shell: the user is in an interactive TUI session

## Repository docs

{{docsContext}}

Read these files when you need detailed reference for a specific topic.

## Command reference

{{commandIndex}}

### Key commands in detail

**run** — Execute the next unchecked TODO task from a source file or directory.
\`rundown run <source> [--all] [--commit] [--mode tui|wait] [--verify] [--repair-attempts <n>] [--sort <mode>] [--redo] [--clean] [--show-agent-output] -- <worker>\`
Use \`--all\` to process all tasks sequentially. Use \`--commit\` to auto-commit on completion. Use \`--mode tui\` for interactive handoff. Use \`--worker <pattern>\` on PowerShell instead of \`-- <command>\`.

**call** — Run a clean full-pass execution (\`--all --clean --cache-cli-blocks\`). Single command for a complete pass over a source.
\`rundown call <source> -- <worker>\`

**loop** — Repeat call executions with cooldown between iterations.
\`rundown loop <source> [--cooldown <s>] [--iterations <n>] [--continue-on-error] -- <worker>\`

**plan** — Generate TODO tasks from a Markdown document. Runs convergent scan passes that only add items.
\`rundown plan <file.md> [--scan-count <n>] [--deep <n>] -- <worker>\`
Use \`--deep <n>\` for nested child TODO generation after top-level scans converge.

**research** — Enrich a document with implementation context before planning. Rewrites body with richer structure, preserves checkboxes, never adds new TODOs.
\`rundown research <file.md> -- <worker>\`

**explore** — Sequential \`research\` then \`plan\` on the same file. Convenience for enrichment flow.
\`rundown explore <file.md> [--scan-count <n>] [--deep <n>] -- <worker>\`

**make** — Create a new Markdown file from seed text, then research + plan it.
\`rundown make "<seed>" "<file.md>" -- <worker>\`

**do** — \`make\` followed by executing all tasks. Full end-to-end from idea to completion.
\`rundown do "<seed>" "<file.md>" -- <worker>\`

**discuss** — Interactive task refinement session. Agent can edit task text, split tasks, add sub-items. Does not execute or complete tasks.
\`rundown discuss <source> [--mode tui] -- <worker>\`

**reverify** — Re-run verification from saved artifacts for a previously completed task.
\`rundown reverify [--run <id|latest>] [--last <n>] [--all] [--no-repair] -- <worker>\`

**revert** — Undo completed tasks by reverting their git commits.
\`rundown revert [--run <id|latest>] [--last <n>] [--all] [--method revert|reset] [--dry-run] -- <worker>\`

**list** / **next** — Inspect unchecked tasks. \`list\` shows all; \`next\` shows the next runnable one.
\`rundown list <source> [--all]\`

**artifacts** / **log** — Inspect saved run metadata and run history.

**memory-view** / **memory-validate** / **memory-clean** — Manage source-local memory files.

**unlock** — Release a stale per-source lockfile.

**init** — Scaffold \`.rundown/\` with default templates, \`vars.json\`, and \`config.json\`.

### Worker forms

\`\`\`bash
rundown run <source> -- opencode run                          # separator form
rundown run <source> --worker "opencode run --file $file $bootstrap"  # pattern form (PowerShell-safe)
\`\`\`

If \`.rundown/config.json\` has a default worker configured, \`--worker\` and \`--\` can be omitted.

### Common patterns

- **Run one task:** \`rundown run docs/todo.md -- opencode run\`
- **Run all tasks:** \`rundown run docs/ --all -- opencode run\`
- **Run all + commit each:** \`rundown run docs/ --all --commit -- opencode run\`
- **Plan a document:** \`rundown plan docs/spec.md --scan-count 3 -- opencode run\`
- **Research then plan:** \`rundown explore docs/spec.md -- opencode run\`
- **New task from scratch:** \`rundown do "implement auth middleware" "tasks/auth.md" -- opencode run\`
- **Check before release:** \`rundown reverify --no-repair -- opencode run\`
- **Undo last task:** \`rundown revert --run latest -- opencode run\`
- **See what's next:** \`rundown next .\`
- **Preview without running:** add \`--dry-run\` or \`--print-prompt\` to any command

### Task prefixes (in Markdown checkboxes)

- **\`cli: <command>\`** — Execute shell command directly instead of using a worker.
- **\`verify: <assertion>\`** — Verify-only task (confirm:, check: are aliases).
- **\`memory: <prompt>\`** — Capture information to source-local memory (memorize:, remember:, inventory:).
- **\`fast: <task>\`** — Skip verification for this task (raw: is an alias).
- **\`end: <condition>\`** — Stop processing siblings when condition is true (return:, skip:, quit:, break:).
- **\`include: <file.md>\`** — Include and execute tasks from another file.
- **\`profile: <name>\`** — Select a named worker profile for this task.
- Prefixes compose: \`profile: fast, verify: tests pass\`

### Configuration (\`.rundown/config.json\`)

Layered worker resolution (lowest to highest priority):
1. \`defaults\` in config
2. \`commands.<command>\` in config
3. Markdown frontmatter \`profile: <name>\`
4. Parent directive \`- profile: <name>\`
5. Task prefix \`profile: <name>\`
6. CLI \`--worker\` or \`-- <command>\`

### Templates (\`.rundown/*.md\`)

Customizable templates: \`execute.md\`, \`verify.md\`, \`repair.md\`, \`plan.md\`, \`discuss.md\`, \`research.md\`, \`help.md\`. Built-in defaults are used when files are absent.

## Behavior

- Be concise. Give direct answers. Skip preamble.
- When the user describes a goal, suggest the specific \`rundown\` command with the right flags.
- When multiple approaches exist, state the recommended one first, then mention alternatives briefly.
- For destructive or irreversible actions (\`revert --method reset\`, \`--force\`, \`--clean\`), confirm with the user before proceeding.
- If a command fails, diagnose the likely cause and suggest a fix.
- When you are unsure about a detail, read the relevant file from the docs/ directory listed above.
- If the user's request has nothing to do with rundown or task management, just answer it normally — you are a helpful assistant first.
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

Review the document and evaluate whether existing TODO items fully cover the described workload. If coverage gaps exist, append new items.

## Rundown feature reference for planning

Use built-in prefixes when they improve execution quality:

- \`verify:\` skips execution and runs only the verification phase. Use it for tasks that assert existing state without doing any work (e.g. "verify: all tests pass", "verify: config file exists"). Do NOT use \`verify:\` for tasks that require creating, writing, or changing anything — those need execution.
- \`fast:\` executes the task but skips the verification phase entirely. Use it for small, mechanical changes where per-task verification is wasteful (e.g. renaming a variable, adding an import). Group several such steps under a \`fast:\` directive parent when they make more sense verified together at the end.
- \`profile: <name>\` to choose a worker profile for specific tasks.
- \`memory:\` for tasks that should capture reusable context.
- \`include: <path>\` to delegate subtasks to another Markdown file.

Always use the canonical prefix name. Do not use aliases (\`check:\`, \`confirm:\`, \`raw:\`, \`memorize:\`, \`remember:\`, \`inventory:\`). If an existing item uses an alias, normalize it to the canonical form.

You can apply prefixes in either form:

- Inline on a checkbox task, for example \`- [ ] verify: all tests pass\`.
- As a directive parent that applies to child checkbox items, for example:

  \`- verify:\`
  \`  - [ ] All tests pass\`
  \`  - [ ] Linting is clean\`

Prefix composition is supported with \`, \` or \`; \` separators when combining known prefixes, for example:

- \`- [ ] profile: fast, verify: release checks pass\`
- \`- [ ] profile: complex; memory: record migration constraints\`

Heuristics:

- Use \`verify:\` only when the task checks existing state without doing work. If the task creates, writes, or modifies anything, it is NOT a verify task.
- Use \`fast:\` when the task is a small mechanical edit that does not warrant its own verification pass.
- Use \`profile:\` when task complexity or cost/speed trade-offs suggest a non-default worker.
- Use directive parents when multiple adjacent tasks share the same prefix.
- Prefer plain \`- [ ]\` items when no special behavior is needed.

Rules:
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Prefer appending new items at the end of the document. Each task only sees the document content above it, so items placed at the end have the most context available during execution.
- Do not insert new items between existing items or between prose paragraphs. Append after the last existing TODO item or at the document end.
- Do not reword, rephrase, or rewrite the descriptive text of any existing TODO item.
- You may fix prefixes on existing unchecked items: normalize aliases to canonical form (e.g. \`check:\` → \`verify:\`), add a missing prefix when the task clearly needs one, or remove an incorrect prefix.
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove or move any existing item (checked or unchecked).
- Do not output a proposed list on stdout; apply edits to \`{{file}}\` directly.
- If plan coverage is already sufficient, leave the file unchanged.
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

## Rundown feature reference for deep planning

Use built-in prefixes when they improve execution quality for child tasks:

- \`verify:\` skips execution and runs only the verification phase. Use it for child tasks that assert existing state without doing any work (e.g. "verify: all tests pass"). Do NOT use \`verify:\` for tasks that require creating, writing, or changing anything — those need execution.
- \`fast:\` executes the task but skips the verification phase entirely. Use it for small, mechanical changes where per-task verification is wasteful.
- \`profile: <name>\` to choose a worker profile for specific child tasks.
- \`memory:\` for child tasks that should capture reusable context.
- \`include: <path>\` to delegate child subtasks to another Markdown file.

Always use the canonical prefix name. Do not use aliases (\`check:\`, \`confirm:\`, \`raw:\`, \`memorize:\`, \`remember:\`, \`inventory:\`). If an existing item uses an alias, normalize it to the canonical form.

You can apply prefixes in either form:

- Inline on a checkbox child task, for example \`- [ ] verify: all unit tests pass\`.
- As a directive parent that applies to child checkbox items, for example:

  \`- verify:\`
  \`  - [ ] All tests pass\`
  \`  - [ ] Linting is clean\`

Prefix composition is supported with \`, \` or \`; \` separators when combining known prefixes, for example:

- \`- [ ] profile: fast, verify: release checks pass\`
- \`- [ ] profile: complex; memory: record migration constraints\`

Heuristics:

- Use \`verify:\` only when the child task checks existing state without doing work. If the task creates, writes, or modifies anything, it is NOT a verify task.
- Use \`fast:\` when the child task is a small mechanical edit that does not warrant its own verification pass.
- Prefer grouping child tasks as \`fast:\` steps followed by a \`verify:\` step that validates the group. A parent task can have multiple such groups when work naturally splits into stages.
- Use \`profile:\` when child task complexity or cost/speed trade-offs suggest a non-default worker.
- Use directive parents when multiple adjacent child tasks share the same prefix.
- Prefer plain \`- [ ]\` child items when no special behavior is needed.

Rules:
- Scope changes strictly to child TODO items under the selected parent task.
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Append new child items after the last existing child under the parent. Do not insert between existing children.
- Do not reword, rephrase, or rewrite the descriptive text of any existing child item.
- You may fix prefixes on existing unchecked items: normalize aliases to canonical form (e.g. \`check:\` → \`verify:\`), add a missing prefix when the task clearly needs one, or remove an incorrect prefix.
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove or move any existing child item (checked or unchecked).
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

