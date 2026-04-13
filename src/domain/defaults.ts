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

## Workspace context

- Invocation directory: \`{{invocationDir}}\`
- Workspace directory: \`{{workspaceDir}}\`
- Workspace link path: \`{{workspaceLinkPath}}\`
- Linked workspace: \`{{isLinkedWorkspace}}\`
- Prediction design directory: \`{{workspaceDesignDir}}\`
- Prediction specs directory: \`{{workspaceSpecsDir}}\`
- Prediction migrations directory: \`{{workspaceMigrationsDir}}\`
- Prediction design path: \`{{workspaceDesignPath}}\`
- Prediction specs path: \`{{workspaceSpecsPath}}\`
- Prediction migrations path: \`{{workspaceMigrationsPath}}\`

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

Complete the task described above. Make the necessary changes to the project, but **never edit the source Markdown task file** (\`{{file}}\`).

- Do not modify \`{{file}}\` in any way: do not change checkboxes, rewrite task items, insert content, add documentation, or restructure the file.
- Inserting research notes, headings, or any other text into the task file shifts line numbers and breaks rundown's internal tracking.
- Do not treat editing the TODO file itself as evidence that the task is done unless the task explicitly requires documentation changes in that file.
- If the task asks you to document findings, write them to a separate file — not the task file.
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
You are a capable \`rundown\` operator, not a command lookup bot.

Your primary job is intent-to-workflow mapping: infer what the user is trying to accomplish, choose the best \`rundown\` flow, and carry the work forward. Do not stop at naming commands when you can execute or coordinate the next step.

Treat natural requests as workflow triggers. For example, "plan this" maps to \`rundown plan\`, "explore this" maps to \`rundown explore\`, and "run everything" maps to \`rundown run --all\` or \`rundown call\` depending on intent.

Remain a general-purpose assistant: if a request is unrelated to rundown, answer directly. When a request can be handled by rundown, prefer rundown-native operations.

## Environment

- CLI version: {{cliVersion}}
- Working directory: {{workingDirectory}}
- Shell: the user is in an interactive TUI session

## Linked workspace awareness (\`rundown start\`)

\`rundown start\` can initialize work from a directory that links to another source workspace. In that setup, the invocation directory and the effective source/workspace directory may differ.

When helping the user, treat this as first-class context:

- Confirm which path is the invocation location vs the actual workspace root when path-sensitive actions are requested.
- Assume edits, task discovery, and execution should target the effective workspace/source context, not whichever path is mentioned first in conversation.
- If paths appear inconsistent, call out the linked-workspace possibility and suggest checking link metadata (for example \`.rundown/workspace.link\`) before proceeding.
- Keep guidance explicit about where commands should run and where files will be changed.

Examples:

- "explore this from my linked folder" -> prefer \`rundown explore <source.md>\` against the linked source workspace and state that execution follows the linked workspace context.
- "plan tasks here" in a linked directory -> run \`rundown plan <file.md>\`, but clarify whether "here" means invocation dir or linked workspace root before applying path-relative assumptions.

## Repository-specific migration guidance

For this repository's own work tracking, treat \`migrations/\` as the canonical task backlog.

- Migration files are Markdown task files under \`migrations/\` and usually follow the local naming pattern \`<number>. <title>.md\` (for example \`65. Improve help.md\`).
- Each migration file is the source of truth for its task list. Execute unchecked items from the migration file itself, not from run artifacts.
- Do not manually toggle checkboxes in migration files as a completion shortcut; completion should follow successful rundown execute/verify flow.
- Keep migration edits scoped to the selected task. Avoid rewriting unrelated checklist items, renumbering files, or reformatting migration history unless explicitly requested.
- Treat \`migrations/.rundown/\` memory files and run metadata as managed artifacts: read them when relevant, but do not invent replacement structures.
- Distinguish repository migration-task files from prediction-mode migration naming (\`0007-...\` and \`0007--snapshot.md\`) used by \`rundown start\`/\`rundown migrate\` project scaffolds.

## Repository docs

{{docsContext}}

Read these files when you need detailed reference for a specific topic.

## Command reference

{{commandIndex}}

\`\`\`cli
rundown --help --everything
\`\`\`

### Key commands in detail

**run** — Execute the next unchecked TODO task from a source file or directory.
\`rundown run <source> [--all] [--commit] [--mode tui|wait] [--verify] [--repair-attempts <n>] [--resolve-repair-attempts <n>] [--sort <mode>] [--redo] [--clean] [--show-agent-output] -- <worker>\`
Use \`--all\` to process all tasks sequentially. Use \`--commit\` to auto-commit on completion. Use \`--mode tui\` for interactive handoff. Use \`--worker <pattern>\` on PowerShell instead of \`-- <command>\`.

**call** — Run a clean full-pass execution (\`--all --clean --cache-cli-blocks\`). Single command for a complete pass over a source.
\`rundown call <source> -- <worker>\`

### Choosing the right execution flow

Use this decision policy so intent maps to the right command:

- **\`plan\`** — Use when the user wants to *generate or refine TODO tasks* from a document before execution.
  - Signals: "plan this", "break this into tasks", "turn this spec into a checklist"
  - Example: \`rundown plan docs/feature.md --scan-count 3 -- opencode run\`
- **\`explore\`** — Use when the user wants *research + planning together* (understand first, then produce tasks).
  - Signals: "explore this", "analyze then plan", "research this file and create tasks"
  - Example: \`rundown explore docs/feature.md --deep 1 -- opencode run\`
- **\`run\`** — Use when the user wants to *execute tasks incrementally* (one task or controlled multi-task run).
  - Signals: "do the next task", "run this task list", "execute tasks with verification"
  - Example (next task): \`rundown run docs/todo.md -- opencode run\`
  - Example (all tasks): \`rundown run docs/todo.md --all --verify -- opencode run\`
- **\`call\`** — Use when the user wants a *clean, full-pass execution* in one command and defaults are acceptable.
  - Signals: "run everything cleanly", "full pass", "just process the whole file"
  - Example: \`rundown call docs/todo.md -- opencode run\`

When both \`run --all\` and \`call\` could work, recommend \`call\` for a clean full pass, and recommend \`run\` when the user needs fine-grained control over flags (for example \`--commit\`, \`--repair-attempts\`, or \`--mode tui\`).

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
- **\`optional: <condition>\`** — Conditionally stop processing siblings when condition is true (preferred canonical form).
- **\`skip: <condition>\`** — Preferred concise alias for \`optional:\` with identical behavior. Legacy aliases: end:, return:, quit:, break:.
- **\`include: <file.md>\`** — Include and execute tasks from another file.
- **\`profile=<name>\`** — Select a named worker profile for this task.
- Prefixes compose: \`profile=fast, verify: tests pass\`

### Configuration (\`.rundown/config.json\`)

Layered worker resolution (lowest to highest priority):
1. \`defaults\` in config
2. \`commands.<command>\` in config
3. Markdown frontmatter \`profile: <name>\`
4. Parent directive \`- profile=<name>\`
5. Task prefix \`profile=<name>\`
6. CLI \`--worker\` or \`-- <command>\`

### Templates (\`.rundown/*.md\`)

Customizable templates: \`execute.md\`, \`verify.md\`, \`repair.md\`, \`resolve.md\`, \`plan.md\`, \`discuss.md\`, \`research.md\`, \`help.md\`. Built-in defaults are used when files are absent.

### Fallback mode for non-rundown questions

When a user asks for general help that does not involve rundown workflows, answer directly as a normal assistant.

- Do not force a rundown command when the user is asking for general coding, debugging, writing, or explanation help.
- Keep answers useful and complete even when no rundown command is used.
- If a request is partly general and partly workflow-oriented, handle the general part directly and then offer the best rundown-native next step.
- Prefer rundown-native operations only when they clearly help execute, plan, or manage task-file work.

## Behavior

- Be concise. Give direct answers. Skip preamble.
- When the user describes a goal, map it to the best \`rundown\` workflow and proceed with concrete next action (execute command, or provide an exact ready-to-run command when execution is not possible).
- Prefer workflow outcomes over command trivia: explain why this flow fits, then move the task forward.
- When multiple approaches exist, state the recommended one first, then mention alternatives briefly.
- For destructive or irreversible actions (\`revert --method reset\`, \`--force\`, \`--clean\`), confirm with the user before proceeding.
- If a command fails, diagnose the likely cause and suggest a fix.
- When you are unsure about a detail, read the relevant file from the docs/ directory listed above.
- If the user's request has nothing to do with rundown or task management, answer it normally as a capable general assistant.
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
 * Default migrate prompt template used to propose the next migration.
 */
export const DEFAULT_MIGRATE_TEMPLATE = `\
You are planning the next migration step for a prediction-driven project.

## Position

- Current migration number: {{position}}

## Design revisions

- Comparison available: {{designRevisionDiffHasComparison}}
- Previous revision: {{designRevisionFromRevision}}
- Target: {{designRevisionToTarget}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

### Diff source references

{{designRevisionDiffSources}}

## Design

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Latest context

{{latestContext}}

## Latest migration

{{latestMigration}}

## Latest backlog

{{latestBacklog}}

## Migration history

{{migrationHistory}}

## Task

Propose ranked alternatives for the next migration.

Return exactly this format:

1. \`<kebab-case-name>\` - <short title>
   - Why now: <reason tied to design/context>
   - Scope: <clear boundaries>
   - Risks: <main tradeoff>

2. \`<kebab-case-name>\` - <short title>
   - Why now: <reason tied to design/context>
   - Scope: <clear boundaries>
   - Risks: <main tradeoff>

3. \`<kebab-case-name>\` - <short title>
   - Why now: <reason tied to design/context>
   - Scope: <clear boundaries>
   - Risks: <main tradeoff>

Rules:
- Names must be kebab-case and suitable for \`NNNN-name.md\`.
- Keep each alternative independent and actionable.
- Rank by expected value for the project right now.
`;

/**
 * Default migrate-context template used to build incremental context.
 */
export const DEFAULT_MIGRATE_CONTEXT_TEMPLATE = `\
You are updating migration context incrementally.

## Position

- Current migration number: {{position}}

## Design revisions

- Comparison available: {{designRevisionDiffHasComparison}}
- Previous revision: {{designRevisionFromRevision}}
- Target: {{designRevisionToTarget}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

## Design

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Previous context

{{latestContext}}

## Latest migration

{{latestMigration}}

## Latest backlog

{{latestBacklog}}

## Migration history

{{migrationHistory}}

## Task

Produce an updated context document that merges the previous context with the
new information introduced by the latest migration.

Rules:
- Preserve still-valid context from previous context.
- Focus on durable facts, constraints, and decisions.
- Remove or correct outdated assumptions.
- Return Markdown only.
`;

/**
 * Default migrate-snapshot template used to capture current state.
 */
export const DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE = `\
You are producing a migration snapshot of project state.

## Position

- Current migration number: {{position}}

## Design revisions

- Comparison available: {{designRevisionDiffHasComparison}}
- Previous revision: {{designRevisionFromRevision}}
- Target: {{designRevisionToTarget}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

## Design

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Latest context

{{latestContext}}

## Latest migration

{{latestMigration}}

## Latest backlog

{{latestBacklog}}

## Migration history

{{migrationHistory}}

## Task

Write a concise state snapshot in Markdown covering:
- Current implemented direction
- Active assumptions
- Known gaps and risks
- Immediate next opportunities

Use concrete references to migration history where relevant.
`;

/**
 * Default migrate-backlog template used to extract technical debt/work items.
 */
export const DEFAULT_MIGRATE_BACKLOG_TEMPLATE = `\
You are generating a backlog from migration progress.

## Position

- Current migration number: {{position}}

## Design revisions

- Comparison available: {{designRevisionDiffHasComparison}}
- Previous revision: {{designRevisionFromRevision}}
- Target: {{designRevisionToTarget}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

## Design

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Latest context

{{latestContext}}

## Latest migration

{{latestMigration}}

## Existing backlog

{{latestBacklog}}

## Migration history

{{migrationHistory}}

## Task

Generate a prioritized Markdown backlog of follow-up work.

Rules:
- Include only items justified by design/context/history.
- Separate near-term tasks from longer-term debt.
- Keep items specific enough to become migrations.
- Remove stale items already addressed.
`;

/**
 * Default migrate-review template used to compare current state to design.
 */
export const DEFAULT_MIGRATE_REVIEW_TEMPLATE = `\
You are reviewing migration progress against intended design.

## Position

- Current migration number: {{position}}

## Design revisions

- Comparison available: {{designRevisionDiffHasComparison}}
- Previous revision: {{designRevisionFromRevision}}
- Target: {{designRevisionToTarget}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

## Design

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Latest context

{{latestContext}}

## Latest migration

{{latestMigration}}

## Latest backlog

{{latestBacklog}}

## Migration history

{{migrationHistory}}

## Task

Write a Markdown review with:
- Alignment: where implementation trajectory matches design
- Drift: where trajectory diverges and why
- Risk: implications of drift
- Recommendations: concrete corrective next migrations
`;

/**
 * Default migrate UX template used to generate user scenarios and questions.
 */
export const DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE = `\
You are evaluating user experience implications of migration progress.

## Position

- Current migration number: {{position}}

## Design revisions

- Comparison available: {{designRevisionDiffHasComparison}}
- Previous revision: {{designRevisionFromRevision}}
- Target: {{designRevisionToTarget}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

## Design

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Latest context

{{latestContext}}

## Latest migration

{{latestMigration}}

## Latest backlog

{{latestBacklog}}

## Migration history

{{migrationHistory}}

## Task

Write a Markdown UX analysis with:
- Primary user scenarios
- Friction points and uncertainty
- Missing validations
- Open questions for product/design

For open questions, use this exact checklist format:

- [ ] question: <clear user/product question>
`;

/**
 * Default undo prompt template used by the undo command.
 */
export const DEFAULT_UNDO_TEMPLATE = DEFAULT_TASK_TEMPLATE;

/**
 * Default test verification prompt template used by the test command.
 */
export const DEFAULT_TEST_VERIFY_TEMPLATE = DEFAULT_VERIFY_TEMPLATE;

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

## Last validation error

{{lastValidationError}}

## Validation channels

- Content-shape validation error: {{contentShapeValidationError}}
- Task-state validation error: {{taskStateValidationError}}

Please fix what is missing or incorrect. The validation above explains what still needs to be done.

When both channels are present, prioritize content-shape fixes first and do not conflate them with task-state handling.

Task-state ownership rules:

- Do not emit checklist transitions like [x] / [ ] as task-state output.
- Do not attempt to complete task-state bookkeeping in your response.
- Runner/orchestrator owns checkbox completion after verification passes.

- Do not change the checkbox in the source Markdown file.
- Do not mark the task complete yourself.
- rundown will update task completion only after validation succeeds.

After making corrections, the task will be validated again.
{{traceInstructions}}
`;

/**
 * Default resolve-phase prompt template used after repair attempts are exhausted.
 */
export const DEFAULT_RESOLVE_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Diagnose why verification still fails after repair attempts are exhausted.

Review all available context and determine the most likely root cause.

## Verification failure

{{verificationFailureMessage}}

## Original execution stdout

{{executionStdout}}

## Repair attempt history

{{repairAttemptHistory}}

Return exactly one verdict line on stdout:

- \`RESOLVED: <root cause diagnosis>\`
- \`UNRESOLVED: <why diagnosis is not possible from available context>\`

Output only the verdict line and nothing else.

Do not modify the source Markdown task file or change its checkbox state.
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
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Edit the source Markdown file directly to improve plan coverage.

Review the document and evaluate whether existing TODO items fully cover the described workload. If coverage gaps exist, append new items.

Never invent TODO items based on examples, sample output, or hypothetical scenarios found in the document. TODO items must address the actual work described by the document — not illustrative content. If you cannot determine the real workload from the document, do not add any items.

## Optional planning guidance (advisory)

Optional prepend guidance (advisory):

{{planPrependGuidance}}

Optional append guidance (advisory):

{{planAppendGuidance}}

Interpret guidance semantically for ordering and coverage decisions.

- Treat guidance as intent hints, not mandatory text.
- Do not copy TODO text literally from guidance examples.
- Ignore guidance that is not relevant to the source document's actual workload.
- Guidance never overrides add-only, checkbox-state, or other planner safety rules.

## Rundown feature reference for planning

Use built-in prefixes when they improve execution quality:

- \`verify:\` skips execution and runs only the verification phase. Use it for tasks that assert existing state without doing any work (e.g. "verify: all tests pass", "verify: config file exists"). Do NOT use \`verify:\` for tasks that require creating, writing, or changing anything — those need execution.
- \`fast:\` executes the task but skips the verification phase entirely. Use it for small, mechanical changes where per-task verification is wasteful (e.g. renaming a variable, adding an import). Group several such steps under a \`fast:\` directive parent when they make more sense verified together at the end.
- \`profile=<name>\` to choose a worker profile for specific tasks.
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

- \`- [ ] profile=fast, verify: release checks pass\`
- \`- [ ] profile=complex; memory: record migration constraints\`

Heuristics:

- Use \`verify:\` only when the task checks existing state without doing work. If the task creates, writes, or modifies anything, it is NOT a verify task.
- Use \`fast:\` when the task is a small mechanical edit that does not warrant its own verification pass.
- Use \`profile=\` when task complexity or cost/speed trade-offs suggest a non-default worker.
- Use directive parents when multiple adjacent tasks share the same prefix.
- Prefer plain \`- [ ]\` items when no special behavior is needed.

Rules:
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Prefer appending new items at the end of the document. Each task only sees the document content above it, so items placed at the end have the most context available during execution.
- Do not insert new items between existing items or between prose paragraphs. Append after the last existing TODO item or at the document end.
- Do not reword, rephrase, or rewrite the descriptive text of any existing TODO item.
- You may fix prefixes on existing unchecked items: normalize aliases to canonical form (e.g. \`check:\` → \`verify:\`), add a missing prefix when the task clearly needs one, or remove an incorrect prefix.
- Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked items (for example repeated \`fast:\`/\`verify:\` wrappers or stacked identical prefixes introduced by prior planning passes).
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
${DEFAULT_TEMPLATE_VARS_SECTION}

## Parent task context

- Parent task: {{parentTask}}
- Parent line: {{parentTaskLine}}
- Parent depth: {{parentTaskDepth}}

## Phase

Edit the source Markdown file directly to improve child plan coverage for the parent task above.

Review \`{{file}}\` and add missing unchecked child TODO items under this parent task.

## Optional planning guidance (advisory)

Optional prepend guidance (advisory):

{{planPrependGuidance}}

Optional append guidance (advisory):

{{planAppendGuidance}}

Interpret guidance semantically for ordering and coverage decisions.

- Treat guidance as intent hints, not mandatory text.
- Do not copy TODO text literally from guidance examples.
- Ignore guidance that is not relevant to the source document's actual workload.
- Guidance never overrides add-only, checkbox-state, or other planner safety rules.

## Rundown feature reference for deep planning

Use built-in prefixes when they improve execution quality for child tasks:

- \`verify:\` skips execution and runs only the verification phase. Use it for child tasks that assert existing state without doing any work (e.g. "verify: all tests pass"). Do NOT use \`verify:\` for tasks that require creating, writing, or changing anything — those need execution.
- \`fast:\` executes the task but skips the verification phase entirely. Use it for small, mechanical changes where per-task verification is wasteful.
- \`profile=<name>\` to choose a worker profile for specific child tasks.
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

- \`- [ ] profile=fast, verify: release checks pass\`
- \`- [ ] profile=complex; memory: record migration constraints\`

Heuristics:

- Use \`verify:\` only when the child task checks existing state without doing work. If the task creates, writes, or modifies anything, it is NOT a verify task.
- Use \`fast:\` when the child task is a small mechanical edit that does not warrant its own verification pass.
- Prefer grouping child tasks as \`fast:\` steps followed by a \`verify:\` step that validates the group. A parent task can have multiple such groups when work naturally splits into stages.
- Use \`profile=\` when child task complexity or cost/speed trade-offs suggest a non-default worker.
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
${DEFAULT_TEMPLATE_VARS_SECTION}

## Full document

{{source}}

## Design context

{{design}}

### Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

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
- Treat managed design docs as first-class context when present:
  - \`design/current/**\`
  - \`design/rev.*/**\`
  Fall back to legacy \`docs/current/**\`, \`docs/rev.*/**\`, and root \`Design.md\` only when canonical design paths are unavailable.
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
 * Default query seed template used to frame natural-language investigations.
 */
export const DEFAULT_QUERY_SEED_TEMPLATE = `\
# Query: {{query}}

## Objective

Research and produce a comprehensive answer to the query above.
This document describes what to investigate, not what to build.

## Analysis directory

\`{{dir}}\`

## Output directory

Each investigation step writes findings to \`{{workdir}}\` when file output mode is enabled.

## Exclusions

Ignore files inside \`.rundown\` directories. They contain runtime artifacts and are not part of the source.
`;

/**
 * Query seed template for yes/no verdict-oriented checks.
 */
export const DEFAULT_QUERY_YN_SEED_TEMPLATE = `\
# Query: {{query}}

## Objective

Investigate the codebase and answer the query as a strict yes/no check.
Conclude with a single verdict token: \`Y\` or \`N\`.

## Analysis directory

\`{{dir}}\`

## Output directory

Each investigation step writes findings to \`{{workdir}}\` when file output mode is enabled.

## Exclusions

Ignore files inside \`.rundown\` directories. They contain runtime artifacts and are not part of the source.
`;

/**
 * Query seed template for success/failure verification-style checks.
 */
export const DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE = `\
# Query: {{query}}

## Objective

Investigate the codebase and evaluate whether the query condition passes.
Conclude with exactly one verdict line: \`success\` or \`failure: <reason>\`.

## Analysis directory

\`{{dir}}\`

## Output directory

Each investigation step writes findings to \`{{workdir}}\` when file output mode is enabled.

## Exclusions

Ignore files inside \`.rundown\` directories. They contain runtime artifacts and are not part of the source.
`;

/**
 * Default file-mode query execution template.
 */
export const DEFAULT_QUERY_EXECUTION_TEMPLATE = `\
You are executing one step of a query investigation plan.

## Step

- Index: {{taskIndex}}
- Task: {{task}}

## Directories

- Analysis root: \`{{dir}}\`
- Workdir: \`{{workdir}}\`

## Instructions

Investigate the task using the analysis root as the codebase context.
Write your findings to this file and do not print the findings to stdout:

\`{{workdir}}/step-{{taskIndex}}.md\`

The file must be Markdown and should include:

1. A short title for the step
2. Key findings with concrete evidence (files, symbols, behaviors)
3. Open questions or uncertainty, if any
4. A concise conclusion for this step
`;

/**
 * Default stream-mode query execution template.
 */
export const DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE = `\
You are executing one step of a query investigation plan.

## Step

- Index: {{taskIndex}}
- Task: {{task}}

## Directory

- Analysis root: \`{{dir}}\`

## Instructions

Investigate the task and print findings directly to stdout in Markdown.
Do not write step output files in this mode.

Include:

1. A short title for the step
2. Key findings with concrete evidence (files, symbols, behaviors)
3. Open questions or uncertainty, if any
4. A concise conclusion for this step
`;

/**
 * Default query aggregation template used to combine step findings.
 */
export const DEFAULT_QUERY_AGGREGATION_TEMPLATE = `\
You are aggregating completed query investigation results.

## Query

{{query}}

## Analysis directory

\`{{dir}}\`

## Workdir

\`{{workdir}}\`

## Instructions

Read all step output files in the workdir (for example, \`step-01.md\`, \`step-02.md\`, ...)
and produce one coherent final response in Markdown.

The final response should:

1. Directly answer the query
2. Synthesize evidence across steps
3. Call out ambiguities or gaps explicitly
4. End with a concise conclusion
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

