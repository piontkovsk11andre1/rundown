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
- Prediction design placement: \`{{workspaceDesignPlacement}}\`
- Prediction specs placement: \`{{workspaceSpecsPlacement}}\`
- Prediction migrations placement: \`{{workspaceMigrationsPlacement}}\`
- Prediction design path: \`{{workspaceDesignPath}}\`
- Prediction specs path: \`{{workspaceSpecsPath}}\`
- Prediction migrations path: \`{{workspaceMigrationsPath}}\`

## Variables

{{userVariables}}
`;

/**
 * Default research output contract template used by built-in research tools.
 *
 * This template is rendered with: `itemLabel`, `metadataPrefix`, and
 * `emptyConditionLabel`.
 */
export const DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE = `\
Return one {{itemLabel}} per line using plain lines or Markdown list items (bulleted/numbered).
Do not use Markdown task checkbox syntax (\`- [ ]\` / \`- [x]\`); use plain lines or simple bullets/numbering instead.
Do not wrap output in code fences.
Use one item per line; do not use JSON or nested structures.
Do not include the literal \`{{metadataPrefix}}\` prefix unless it is part of the value.
Preserve discovery order.
If no {{emptyConditionLabel}}, return an exactly empty response (no lines, no blank lines, no whitespace-only output).
Do not include commentary.
`;

/**
 * Canonical inline output contract sentence for authored `get:` tasks.
 *
 * Used across planner and execution templates to keep get-output guidance
 * stable and prevent prompt drift.
 */
export const DEFAULT_GET_OUTPUT_CONTRACT_SENTENCE =
  "Output one item per line using plain lines or Markdown list items (bulleted or numbered only, no JSON). Do not use Markdown task checkbox syntax (- [ ] / - [x]) and do not include commentary. Preserve discovery order. If none are found, return an exactly empty response (no lines, no blank lines, no whitespace-only output).";

const DEFAULT_PLANNING_FEATURE_REFERENCE_SHARED_FRAGMENT = `\
Use built-in prefixes when they improve execution quality{{qualitySuffix}}:

- \`verify:\` skips execution and runs only the verification phase. Use it for {{verifyTaskSubject}} that assert existing state without doing any work (e.g. {{verifyExamples}}). Do NOT use \`verify:\` for tasks that require creating, writing, or changing anything — those need execution.
- \`fast:\` executes the task but skips the verification phase entirely. Use it for small, mechanical changes where per-task verification is wasteful{{fastExtra}}.
- \`get:\` performs targeted{{getSubject}} fact-finding and stores durable findings back in the source task context (for example via \`get-result:\` lines). Use it when {{getDownstream}} depend on concrete discovered facts (e.g. "get: list impacted modules", "get: inventory existing feature flags").
- \`loop:\` repeats a scoped{{loopSubject}} workflow until a stop condition is met. Use it for iterative {{loopWorkflowNoun}} that may need multiple passes (e.g. "loop: fix failing tests until all pass", "loop: refine {{loopCoverageExample}} until no gaps remain"). Keep loop tasks bounded with explicit success criteria.
- \`profile=<name>\` to choose a worker profile for specific {{profileTaskSubject}}.
- \`memory:\` for {{memoryTaskSubject}} that gather reusable context for later steps when the task does not specify a file to write/edit/create.
- Author new {{memoryAuthorSubject}} TODOs with the canonical \`memory:\` prefix only; \`remember:\`, \`memorize:\`, and \`inventory:\` remain execution-level compatibility aliases and should not be newly authored in {{planModeName}}.
- If {{taskTextSubject}} includes write/edit/create/update filesystem intent, keep it as a normal execution TODO (not \`memory:\`).
- \`include: <path>\` to delegate {{includeSubject}} another Markdown file.

Always use the canonical prefix name. Do not use aliases (\`check:\`, \`confirm:\`, \`raw:\`, \`quick:\`, \`memorize:\`, \`remember:\`, \`inventory:\`). If an existing item uses an alias, normalize it to the canonical form.

You can apply prefixes in either form:

- Inline on a checkbox {{inlineTaskSubject}}, for example \`- [ ] verify: {{inlineVerifyExample}}\`.
- As a directive parent that applies to child checkbox items, for example:

  \`- verify:\`
  \`  - [ ] All tests pass\`
  \`  - [ ] Linting is clean\`

Prefix composition is supported with \`, \` or \`; \` separators when combining known prefixes, for example:

- \`- [ ] profile=fast, verify: release checks pass\`
- \`- [ ] profile=complex; memory: record migration constraints\`

Prefix decision table (choose the closest matching intent):

| Task intent | Preferred prefix | Why |
| --- | --- | --- |
| Discover concrete facts for downstream tasks | \`get:\` | One-pass discovery with durable \`get-result:\` capture. |
| Capture reusable context for later tasks (no file write/edit target) | \`memory:\` | Persists reference context without creating/updating files. |
| Apply a small mechanical change | \`fast:\` | Executes quickly and skips per-task verification overhead. |
| Assert current state only (no edits) | \`verify:\` | Runs verification without execution work. |
| Repeat work until an explicit stop condition | \`loop:\` | Bounded iterative workflow with deterministic completion. |

Heuristics:

- Use \`verify:\` only when the {{inlineTaskSubject}} checks existing state without doing work. If the task creates, writes, or modifies anything, it is NOT a verify task.
- For low-risk small mechanical edits, you MUST classify the {{inlineTaskSubject}} as \`fast:\` (inline or directive parent) instead of leaving it plain/unprefixed.
- Reserve \`verify:\` for behavior/state validation checks. Do not use \`verify:\` as a replacement label for mechanical edit steps.
{{optionalFastGroupingHeuristic}}
- Use \`get:\` when {{getHeuristicTaskSubject}} needs one-pass discovery whose results should be persisted for {{getPersistenceTarget}}.
- Use \`loop:\` when {{loopHeuristicTaskSubject}} is inherently iterative and needs repeated passes until a clear stop condition.
- Use \`profile=\` when {{profileHeuristicTaskSubject}} complexity or cost/speed trade-offs suggest a non-default worker.
- {{memoryHeuristicLine}}
- {{nonMemoryHeuristicLine}}
- Explicit write-target{{explicitWriteHeuristicSuffix}} examples that must remain normal execution TODOs: \`- [ ] Write findings to docs/research-notes.md\`, \`- [ ] Research rollout risks and write findings into docs/rollout-plan.md\`.
- If a {{directiveHeuristicParentSubject}} suggests memory capture intent, still classify each child task {{directiveHeuristicClassifier}}: child tasks with explicit file-write/edit/create/update language must remain normal execution TODOs (no inherited \`memory:\`).
- For mixed intents, split into separate {{splitTaskSubject}} when possible: a \`memory:\` capture task first, then a normal write/edit task.
- Mixed-intent{{splitExampleSuffix}} split example (correct): \`- [ ] memory: research rollout constraints\` and \`- [ ] Write rollout findings to docs/rollout-plan.md\` as separate {{splitTaskSubject}}.
- Use directive parents when multiple adjacent {{adjacentTaskSubject}} share the same prefix.
- Prefer plain \`- [ ]\` {{plainItemSubject}} when no special behavior is needed.

Output contract requirements for agentic tasks:

- For every newly authored \`get:\` {{inlineTaskSubject}}, include this canonical inline output contract sentence in task text: \`${DEFAULT_GET_OUTPUT_CONTRACT_SENTENCE}\` Keep discovery-order wording explicit when relevant, and avoid a literal \`get-result:\` prefix in output instructions because the runtime writes canonical \`get-result:\` sub-items.
- For iterative/unknown \`loop:\` {{inlineTaskSubject}}, require loop decomposition with child \`get:\` + child \`for:\` + child \`memory:\` + optional child \`fast:\` + terminal \`end:\` so per-item execution stays explicit, outputs remain reusable across passes, and the loop always has a deterministic stop signal.
- For \`loop:\` {{inlineTaskSubject}} that mixes iterative discovery with durable context capture, use this bounded child pattern:

  \`- [ ] loop: audit rollout blockers until no new blockers appear\`
  \`  - [ ] get: list one blocker per line. ${DEFAULT_GET_OUTPUT_CONTRACT_SENTENCE}\`
  \`  - [ ] for: run per-blocker implementation/verification child tasks from source task context\`
  \`    - [ ] fast: apply one small mechanical blocker fix when confidence is high\` (optional)
  \`  - [ ] memory: capture blocker trends that should influence the next pass\`
  \`  - [ ] end: stop when two consecutive passes produce no new blockers\`

- For \`loop:\` {{inlineTaskSubject}}, require an explicit terminal stop condition via an \`end:\` step (inline or child) so the loop has a deterministic completion signal.
`;

function buildPlanningFeatureReferenceSection(deep: boolean): string {
  const heading = deep
    ? "## Rundown feature reference for deep planning"
    : "## Rundown feature reference for planning";
  const optionalFastGroupingHeuristic = deep
    ? "- Prefer grouping child tasks as `fast:` steps followed by a `verify:` step that validates the group. A parent task can have multiple such groups when work naturally splits into stages."
    : "";
  const replacements: Array<[string, string]> = [
    ["{{qualitySuffix}}", deep ? " for child tasks" : ""],
    ["{{verifyTaskSubject}}", deep ? "child tasks" : "tasks"],
    ["{{verifyExamples}}", deep ? "\"verify: all tests pass\"" : "\"verify: all tests pass\", \"verify: config file exists\""],
    ["{{fastExtra}}", deep ? "" : " (e.g. renaming a variable, adding an import). Group several such steps under a `fast:` directive parent when they make more sense verified together at the end"],
    ["{{getSubject}}", deep ? " child-task" : ""],
    ["{{getDownstream}}", deep ? "downstream child tasks" : "later tasks"],
    ["{{loopSubject}}", deep ? " child-task" : ""],
    ["{{loopWorkflowNoun}}", deep ? "child workflows" : "improvement tasks"],
    ["{{loopCoverageExample}}", deep ? "child TODO coverage" : "TODO coverage"],
    ["{{profileTaskSubject}}", deep ? "child tasks" : "tasks"],
    ["{{memoryTaskSubject}}", deep ? "child tasks" : "research/context-capture tasks"],
    ["{{memoryAuthorSubject}}", deep ? "child memory-capture" : "memory-capture"],
    ["{{planModeName}}", deep ? "deep plans" : "plans"],
    ["{{taskTextSubject}}", deep ? "child task text" : "task text"],
    ["{{includeSubject}}", deep ? "child subtasks to" : "subtasks to"],
    ["{{inlineTaskSubject}}", deep ? "child task" : "task"],
    ["{{inlineVerifyExample}}", deep ? "all unit tests pass" : "all tests pass"],
    ["{{optionalFastGroupingHeuristic}}", optionalFastGroupingHeuristic],
    ["{{getHeuristicTaskSubject}}", deep ? "a child task" : "the task"],
    ["{{loopHeuristicTaskSubject}}", deep ? "a child task" : "the task"],
    ["{{getPersistenceTarget}}", deep ? "downstream child tasks" : "downstream tasks"],
    ["{{profileHeuristicTaskSubject}}", deep ? "child task" : "task"],
    ["{{memoryHeuristicLine}}", deep
      ? "Use `memory:` when the child task objective is research/inventory/constraints/reference capture for later tasks and there is no explicit target file write/edit/create in that child task."
      : "Use `memory:` when the objective is research/inventory/constraints/reference capture for later tasks and there is no explicit target file write/edit/create in that task."],
    ["{{nonMemoryHeuristicLine}}", deep
      ? "Do NOT use `memory:` when the child task asks to write/edit/create/update any file or persistent document artifact (including \"prepare notes section in this doc\" or \"research and write findings into X.md\"). These must remain normal execution TODOs."
      : "Do NOT use `memory:` when the task asks to write/edit/create/update any file or persistent document artifact (including \"prepare notes section in this doc\" or \"research and write findings into X.md\"). These must remain normal execution TODOs."],
    ["{{explicitWriteHeuristicSuffix}}", deep ? " child" : ""],
    ["{{directiveHeuristicParentSubject}}", deep ? "parent directive" : "directive parent"],
    ["{{directiveHeuristicClassifier}}", deep ? "by its own text" : "on its own text"],
    ["{{splitTaskSubject}}", deep ? "child TODOs" : "TODOs"],
    ["{{splitExampleSuffix}}", deep ? " child" : ""],
    ["{{adjacentTaskSubject}}", deep ? "child tasks" : "tasks"],
    ["{{plainItemSubject}}", deep ? "child items" : "items"],
  ];

  let fragment = DEFAULT_PLANNING_FEATURE_REFERENCE_SHARED_FRAGMENT;
  for (const [token, value] of replacements) {
    fragment = fragment.replaceAll(token, value);
  }

  return `${heading}\n\n${fragment}`;
}

const DEFAULT_PLAN_FEATURE_REFERENCE_SECTION = buildPlanningFeatureReferenceSection(false);
const DEFAULT_DEEP_PLAN_FEATURE_REFERENCE_SECTION = buildPlanningFeatureReferenceSection(true);

/**
 * Canonical root-command welcome line emitted at startup.
 */
export const ROOT_COMMAND_WELCOME_MESSAGE =
  "Welcome to rundown. Start with `plan`, `explore`, `run`, or `help`.";

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

Complete the task described above. Make the necessary changes to the project.

## \`get:\` output contract

When the selected task uses the \`get:\` prefix, enforce this output contract exactly:

- \`${DEFAULT_GET_OUTPUT_CONTRACT_SENTENCE}\`
- Avoid emitting a literal \`get-result:\` prefix unless it is part of the discovered value; the runtime writes canonical \`get-result:\` sub-items.

- By default, do not modify the source Markdown task file (\`{{file}}\`).
- Exception: if the selected task explicitly requires edits to \`{{file}}\`, make only the requested content changes.
- Even when edits to \`{{file}}\` are explicitly required, do not change checkbox state unless the task explicitly asks for it.
- Inserting research notes, headings, or any other text into the task file shifts line numbers and breaks rundown's internal tracking.
- Do not treat editing the TODO file itself as evidence that the task is done unless the selected task explicitly required those edits.
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

Primary role:

- analyze the selected task and answer user questions
- use related run history as supporting context when helpful
- keep the session conversational-first unless the user explicitly requests edits

Editing contract:

- do not edit the source Markdown task text by default
- only edit when the user explicitly asks (for example: rewrite wording, split tasks, add sub-items, or clarify scope)
- do not mark tasks complete or change checkbox state
- do not perform implementation work in this phase

## Related run history

{{relatedRunsSummary}}

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
- when explicit edits are requested, keep changes focused on task clarity and executability
- otherwise stay non-mutating and discussion-only
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

## Root greeting contract

For the root \`rundown\` command path:

Your first assistant output MUST begin with this exact line.
Do not add any text before it (no preface, bullets, or alternate greeting):

${ROOT_COMMAND_WELCOME_MESSAGE}

Emit this line exactly once on the first assistant turn of a new root help session.
Do not repeat it on subsequent turns in the same session.
After this line, continue with normal contextual help.

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

**workspace unlink** / **workspace remove** — Manage linked workspace lifecycle metadata with safe cleanup semantics.

- \`rundown workspace unlink [--workspace <dir|id>] [--all] [--dry-run]\`
  - Metadata-only unlink. Never deletes linked workspace files/directories.
- \`rundown workspace remove [--workspace <dir|id>] [--all] [--delete-files] [--dry-run] [--force]\`
  - Removes metadata; deletes linked files/directories only when \`--delete-files\` is set.
  - Destructive cleanup requires explicit confirmation unless \`--force\` is set.
- If multiple workspace records exist and no selector is provided, command flow fails safely with candidate guidance.
- Use \`--dry-run\` first to preview exactly which records/files would be removed.

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
- **Unlink one workspace record:** \`rundown workspace unlink --workspace ../predict-auth\`
- **Preview destructive cleanup:** \`rundown workspace remove --workspace auth-workspace --delete-files --dry-run\`
- **Delete linked files non-interactively:** \`rundown workspace remove --all --delete-files --force\`
- **Preview without running:** add \`--dry-run\` or \`--print-prompt\` to any command

### Task prefixes (in Markdown checkboxes)

Author new tasks with canonical prefixes only: \`verify:\`, \`memory:\`, \`fast:\`, \`get:\`, and \`loop:\`.
Treat alias prefixes (\`check:\`, \`confirm:\`, \`quick:\`, \`raw:\`, \`memorize:\`, \`remember:\`, \`inventory:\`) as legacy compatibility forms and normalize them to canonical names when encountered.

- **\`cli: <command>\`** — Execute shell command directly instead of using a worker.
- **\`verify: <assertion>\`** — Verify-only task.
- **\`memory: <prompt>\`** — Capture information to source-local memory.
- **\`fast: <task>\`** — Skip verification for this task.
- **\`get: <prompt>\`** — Run focused fact-finding and persist results as canonical \`get-result:\` sub-items under the task.
- **\`loop: <task>\`** — Repeat the scoped task flow until an explicit stop signal (for example an \`end:\` condition) is emitted.
- **\`optional: <condition>\`** — Conditional sibling short-circuit only. When true, skip remaining siblings/descendants in the same parent scope; otherwise continue. This behavior is unchanged.
- **\`skip: <condition>\`** — Preferred concise alias for \`optional:\` with identical sibling-skip behavior.
- **\`quit:\` / \`exit:\` / \`end:\` / \`break:\` / \`return:\`** — Terminal stop control. Empty payload is allowed and means unconditional stop. Non-empty payload is evaluated as yes/no; true emits terminal stop, false continues.
- Terminal stop behavior differs by flow: in normal \`run\`, remaining work is not scheduled after current lifecycle finalization; in \`loop\`, the outer loop exits immediately after the current iteration finalizes.
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

Customizable templates: \`agent.md\`, \`execute.md\`, \`verify.md\`, \`repair.md\`, \`resolve.md\`, \`plan.md\`, \`plan-loop.md\`, \`deep-plan.md\`, \`discuss.md\`, \`discuss-finished.md\`, \`research.md\`, \`research-verify.md\`, \`research-repair.md\`, \`research-resolve.md\`, \`research-output-contract.md\`, \`trace.md\`, \`undo.md\`, \`test-verify.md\`, \`test-future.md\`, \`test-materialized.md\`, \`help.md\`, \`migrate*.md\`, \`query-*.md\`. Built-in defaults are used when files are absent.

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
 * Default no-arg help warmup template prepended before `help.md` content.
 */
export const DEFAULT_AGENT_TEMPLATE = `\
You are running in rundown root no-argument help mode.

Use this as warmup context before interactive help:

- Keep responses concise and action-oriented.
- Map user intent to the most suitable rundown workflow when applicable.
- Stay useful for general questions that are not rundown-specific.
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
 * Default migrate planning template used by the convergence scan loop.
 */
export const DEFAULT_MIGRATE_TEMPLATE = `\
You are planning migration names for a prediction-driven project.

## Position

- Current migration number: {{position}}

## Design diff ({{designRevisionFromRevision}} → {{designRevisionToTarget}})

- Comparison available: {{designRevisionDiffHasComparison}}
- Summary: {{designRevisionDiffSummary}}
- Added files: {{designRevisionDiffAddedCount}}
- Modified files: {{designRevisionDiffModifiedCount}}
- Removed files: {{designRevisionDiffRemovedCount}}

### Changed files

{{designRevisionDiffFiles}}

### Diff

{{designRevisionDiffContent}}

### Diff source references

{{designRevisionDiffSources}}

## Target revision design ({{designRevisionToTarget}})

{{design}}

## Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

## Migration history

{{migrationHistory}}

## Task

Inventory design changes not yet reflected in the current prediction tree.
For each uncovered change, propose exactly one migration name as a kebab-case list item.
If all design changes are already covered by the current prediction tree, output only: \`DONE\`

Rules:
- Output format must be either:
  - Plain list items containing only kebab-case migration names, one per line, or
  - The single token \`DONE\`
- Do not include titles, explanations, numbering metadata, or any extra commentary.
`;

/**
 * Default undo prompt template used by the undo command.
 */
export const DEFAULT_UNDO_TEMPLATE = DEFAULT_TASK_TEMPLATE;

/**
 * Default test verification prompt template used by the test command.
 */
export const DEFAULT_TEST_VERIFY_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Verify whether the selected test assertion is true.

## Test mode

- Mode: {{testMode}}

## Included directories

{{includedDirectories}}

## Excluded directories

{{excludedDirectories}}

## Assertion

{{assertion}}

## Predicted context

### Design

{{design}}

### Design context sources

- Managed docs layout detected: {{designContextHasManagedDocs}}

{{designContextSourceReferences}}

### Migration history

{{migrationHistory}}

Return your verification result on stdout as exactly one of the following:

- \`OK\`
- \`NOT_OK: <short explanation of what is still missing>\`

Output ONLY the verdict line and nothing else.
{{traceInstructions}}
`;

/**
 * Default test verification prompt template for prediction/future mode.
 */
export const DEFAULT_TEST_FUTURE_TEMPLATE = `\
${DEFAULT_TEST_VERIFY_TEMPLATE}

Interpretation rules:

- This run uses standard test verification semantics.
`;

/**
 * Default test verification prompt template for materialized mode.
 */
export const DEFAULT_TEST_MATERIALIZED_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Verify whether the selected test assertion is true.

## Test mode

- Mode: {{testMode}}

## Included directories

{{includedDirectories}}

## Excluded directories

{{excludedDirectories}}

## Assertion

{{assertion}}

Return your verification result on stdout as exactly one of the following:

- \`OK\`
- \`NOT_OK: <short explanation of what is still missing>\`

Output ONLY the verdict line and nothing else.

Interpretation rules:

- This run is in \`materialized\` mode. Evaluate only the materialized workspace state under included directories.
- Ignore prediction inputs entirely (design/specs/migrations) for verdict decisions.
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
 * Default localization prompt template used to translate rundown templates.
 */
export const DEFAULT_LOCALIZE_PROMPT_TEMPLATE = `\
You are localizing a rundown template into {{language}}.

Translate natural-language content while preserving runtime protocol tokens and structural syntax exactly.

Rules:
- Preserve all \`{{double-brace vars}}\` placeholders exactly.
- Preserve protocol verdict/status tokens exactly: \`OK\`, \`NOT_OK:\`, \`RESOLVED:\`, \`UNRESOLVED:\`.
- Preserve Markdown checkbox syntax exactly: \`- [ ]\` and \`- [x]\`.
- Preserve all fenced code blocks exactly, including fence markers, info strings, and body content.
- Do not add commentary, metadata, or wrappers.
- Return only the translated template content.

## Template content

{{content}}
`;

/**
 * Default localization alias template used to generate canonical intent keyword mappings.
 */
export const DEFAULT_LOCALIZE_ALIASES_TEMPLATE = `\
You are generating localized rundown intent keyword aliases for {{language}}.

Return a valid JSON object only. Do not wrap in code fences. Do not include commentary.

Map localized keyword prefixes to canonical English prefixes using this exact format:

{
  "<localized-keyword>:": "<canonical-keyword>:"
}

Canonical keyword groups:
- memory: (aliases: memorize:, remember:, inventory:)
- verify: (aliases: confirm:, check:)
- fast: (aliases: raw:, quick:)
- parallel: (aliases: concurrent:, par:)

Requirements:
- Keys must end with ":".
- Values must be one of: "memory:", "verify:", "fast:", "parallel:".
- Include localized equivalents for canonical keywords and useful localized equivalents for listed aliases.
- Avoid duplicate keys.
- Use deterministic, practical mappings for the specified language/style.
`;

/**
 * Default localization messages template used to translate CLI message catalog values.
 */
export const DEFAULT_LOCALIZE_MESSAGES_TEMPLATE = `\
You are translating a rundown CLI message catalog into {{language}}.

Return valid JSON only. Do not wrap in code fences. Do not include commentary.

The input catalog JSON is:

{{catalog}}

Rules:
- Translate values only (right-hand side strings).
- Do not add, remove, or rename any keys.
- Preserve all {{placeholder}} tokens in values exactly as written.
- Keep punctuation and escape sequences valid for JSON string values.
- If a value has no natural translation in {{language}}, keep the original English value.
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

## Mandatory decomposition order for uncertain work

When newly added TODO items involve uncertain facts, unknown constraints, or iterative investigation, enforce this default order:

1. Add \`get:\` discovery tasks first to collect concrete facts.
2. Add \`memory:\` capture tasks second to persist reusable context from those findings.
3. Add implementation/edit tasks after discovery and memory capture tasks.

When authoring those implementation/edit tasks, explicitly classify low-risk mechanical subtasks as \`fast:\` (inline or directive parent) instead of leaving them plain/unprefixed.

Do not invert this order unless the source document provides a hard dependency that requires a different sequence.

For iterative/unknown work that needs repeated passes, you MUST author a \`loop:\` task (not a flat sequence) and decompose it with child \`get:\`, child \`for:\`, child \`memory:\`, optional child \`fast:\` (typically under \`for:\` for per-item mechanical actions), and a terminal child \`end:\` stop condition.

${DEFAULT_PLAN_FEATURE_REFERENCE_SECTION}

Rules:
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Prefer appending new items at the end of the document. Each task only sees the document content above it, so items placed at the end have the most context available during execution.
- Do not insert new items between existing items or between prose paragraphs. Append after the last existing TODO item or at the document end.
- Do not reword, rephrase, or rewrite the descriptive text of any existing TODO item.
- You may fix prefixes on existing unchecked items: normalize aliases to canonical form (e.g. \`check:\` → \`verify:\`), add a missing prefix when the task clearly needs one, or remove an incorrect prefix.
- Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked items (for example repeated \`fast:\`/\`verify:\` wrappers or stacked identical prefixes introduced by prior planning passes).
- Any \`loop:\` task must include an explicit terminal \`end:\` stop condition (inline or child item).
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove or move any existing item (checked or unchecked).
- Do not output a proposed list on stdout; apply edits to \`{{file}}\` directly.
- If plan coverage is already sufficient, leave the file unchanged.
{{traceInstructions}}
`;

/**
 * Default loop-plan prompt template used to propose loop-oriented TODO workflows.
 */
export const DEFAULT_PLAN_LOOP_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Phase

Edit the source Markdown file directly to add loop-oriented TODO coverage.

Plan for bounded iterative workflows. Favor patterns that discover values, iterate deterministically, and stop explicitly.

## Loop composition requirements

When adding or fixing loop-oriented TODO items, strongly prefer this composition:

1. \`get:\` discovers an iterable set of items/values.
2. \`for:\` iterates discovered values and runs per-item implementation/review child tasks.
3. \`memory:\` captures durable findings/trends from each pass so the next pass can reuse context.
4. \`end:\` defines a deterministic stop rule (for example no discovered values, no new items, or a bounded pass counter).
5. For each per-item child task under \`for:\`, explicitly encode execution intent with a canonical directive: use \`fast:\` for low-risk mechanical actions, and use \`verify:\` for risky or state-sensitive checks. Do not leave per-item child tasks unprefixed.
6. \`for:\` child task wording must state per-item execution intent (implementation and/or verification actions) derived from the source task context.

Preferred loop authoring shape:

- \`- [ ] loop: <bounded iterative objective>\`
- \`  - [ ] get: <discover iterable items in stable order>\`
- \`  - [ ] for: <run per-item implementation/verification tasks from source task context for each discovered item>\`
- \`    - [ ] fast: <small/mechanical per-item action when confidence is high>\`
- \`    - [ ] verify: <risky/state-sensitive per-item check when additional assurance is needed>\`
- \`  - [ ] memory: <capture reusable findings from this pass for next-pass reuse>\`
- \`  - [ ] end: stop when get returns no items (or another explicit deterministic rule)\`

Use clear, deterministic stop conditions. Avoid open-ended loops without an explicit terminal rule.

When a loop could run indefinitely, add an explicit deterministic cap (for example pass count limit) in addition to content-based stopping.

## Additive-only planning safety

Loop planning is additive-only. Author new unchecked TODO items and limited unchecked-prefix normalization only.
Do not rewrite existing task wording, remove items, reorder items, or change checkbox state.

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

${DEFAULT_PLAN_FEATURE_REFERENCE_SECTION}

Rules:
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Prefer appending new items at the end of the document. Each task only sees the document content above it, so items placed at the end have the most context available during execution.
- Do not insert new items between existing items or between prose paragraphs. Append after the last existing TODO item or at the document end.
- Do not reword, rephrase, or rewrite the descriptive text of any existing TODO item.
- You may fix prefixes on existing unchecked items: normalize aliases to canonical form (e.g. \`check:\` → \`verify:\`), add a missing prefix when the task clearly needs one, or remove an incorrect prefix.
- Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked items (for example repeated \`fast:\`/\`verify:\` wrappers or stacked identical prefixes introduced by prior planning passes).
- For loop-oriented tasks, require explicit \`get:\` + \`for:\` + \`end:\` composition unless the source document provides a stronger deterministic pattern.
- Under \`for:\` parents, do not leave per-item child tasks plain/unprefixed. Classify each per-item child task with explicit execution intent (\`fast:\` for low-risk mechanical actions; \`verify:\` for risky/state-sensitive checks).
- Any \`loop:\` task must include an explicit terminal \`end:\` stop condition (inline or child item).
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove or move any existing item (checked or unchecked).
- Do not output a proposed list on stdout; apply edits to \`{{file}}\` directly.
- If plan coverage is already sufficient, leave the file unchanged.
{{traceInstructions}}
`;

/**
 * Default planner prepend guidance template created by `rundown init`.
 *
 * Advisory-only guidance consumed by plan/deep-plan templates.
 */
export const DEFAULT_PLAN_PREPEND_TEMPLATE = `\
When planning implementation work, front-load discovery when facts are uncertain.

- Prefer early \`get:\` tasks for concrete inventory and constraints that downstream TODOs depend on.
- Prefer early \`memory:\` tasks for reusable context capture that should persist across execution steps.
- For iterative unknowns, use \`loop:\` with explicit \`end:\` stop conditions.
`;

/**
 * Default planner append guidance template created by `rundown init`.
 *
 * Advisory-only guidance consumed by plan/deep-plan templates.
 */
export const DEFAULT_PLAN_APPEND_TEMPLATE = `\
When planning implementation work, close with confidence-building completion tasks.

- Use \`fast:\` for small mechanical edits where per-item verification is unnecessary.
- Use \`verify:\` tasks near the end for stack-appropriate validation of changed behavior.
- When \`get:\` or \`loop:\` work uncovers reusable constraints, finish with a \`memory:\` capture task before final \`fast:\`/\`verify:\` closure.
- End multi-step changes with a clear integration or handoff check before task completion.
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

Never invent child TODO items based on examples, sample output, or hypothetical scenarios found in the document. Child TODO items must address the actual work described by the parent task and document context — not illustrative content. If you cannot determine the real workload from the parent task and document context, do not add any items.

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

## Mandatory decomposition order for uncertain child work

When newly added child TODO items involve uncertain facts, unknown constraints, or iterative investigation, enforce this default order:

1. Add \`get:\` discovery child tasks first to collect concrete facts.
2. Add \`memory:\` capture child tasks second to persist reusable context from those findings.
3. Add implementation/edit child tasks after discovery and memory capture tasks.

When authoring those implementation/edit child tasks, explicitly classify low-risk mechanical subtasks as \`fast:\` (inline or directive parent) instead of leaving them plain/unprefixed.

Do not invert this order unless the parent task or source document provides a hard dependency that requires a different sequence.

For iterative/unknown child work that needs repeated passes, you MUST author a \`loop:\` child task (not a flat sequence) and decompose it with child \`get:\`, child \`for:\`, child \`memory:\`, optional child \`fast:\` (typically under \`for:\` for per-item mechanical actions), and a terminal child \`end:\` stop condition.

${DEFAULT_DEEP_PLAN_FEATURE_REFERENCE_SECTION}

Rules:
- Scope changes strictly to child TODO items under the selected parent task.
- Add only unchecked TODO items using \`- [ ]\` syntax.
- Append new child items after the last existing child under the parent. Do not insert between existing children.
- Do not reword, rephrase, or rewrite the descriptive text of any existing child item.
- You may fix prefixes on existing unchecked items: normalize aliases to canonical form (e.g. \`check:\` → \`verify:\`), add a missing prefix when the task clearly needs one, or remove an incorrect prefix.
- Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked child items (for example repeated \`fast:\`/\`verify:\` wrappers or stacked identical prefixes introduced by prior planning passes).
- Any \`loop:\` child task must include an explicit terminal \`end:\` stop condition (inline or child item).
- Do not change any \`- [ ]\` item to \`- [x]\`.
- Do not remove or move any existing child item (checked or unchecked).
- Do not output a proposed list on stdout; apply edits to \`{{file}}\` directly.
- If child plan coverage is already sufficient, leave the file unchanged.
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
  Fall back to legacy \`docs/current/**\`, \`docs/rev.*/**\`, and root \`Design.md\` only as compatibility-only paths when canonical design paths are unavailable.
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
 * Default translate prompt template used to re-express one document into
 * domain vocabulary defined by another document.
 */
export const DEFAULT_TRANSLATE_TEMPLATE = `\
## Source document (<what>)

{{what}}

## Know-how reference (<how>)

{{how}}

## Task

Rewrite the full <what> document so it is naturally expressed in the vocabulary and conceptual framing defined by <how>.
Use the complete text of both documents above as authoritative context.

Rules:

- Meaning fidelity: preserve intent, scope, and constraints from <what>.
- Vocabulary alignment: prefer terms, distinctions, and mental models established by <how>.
- No invention: do not add or invent requirements, tasks, or implementation commitments.
- Uncertainty signaling: when no clear analog exists in <how>, keep the original concept explicit and clearly mark the mismatch.
- Natural target prose: produce native domain writing, not dictionary substitution.
- Markdown validity: return valid Markdown suitable for downstream rundown commands.

Output contract:

- Return only the full translated Markdown document body.
- Do not wrap output in commentary, metadata, or code fences.
- Do not omit sections from <what>; translate the entire document.
`;

/**
 * Default research-verify template used to validate research enrichment quality.
 */
export const DEFAULT_RESEARCH_VERIFY_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Full document before research

{{source}}

## Research output document

{{executionStdout}}

## Phase

Verify whether the research output is acceptable.

Evaluate the output against outcome-level constraints:

- Existing checkbox states are unchanged.
- No new unchecked TODO items were introduced.
- Original author intent is preserved semantically (not line-by-line matching).
- Output remains coherent Markdown suitable for planning.
- Enrichment quality is present (context, constraints, boundaries, acceptance framing).

Use a deterministic verdict contract so orchestration can parse your result.

Return exactly one of:

- \`OK\`
- \`NOT_OK: <specific failure reason>\`

When returning \`NOT_OK\`:

- Name the missing or violated outcome-level constraint directly.
- Keep the reason concrete and repairable in one short sentence.
- Do not propose implementation code or TODO decomposition.

Output ONLY the verdict line - nothing else.
{{traceInstructions}}
`;

/**
 * Default research-repair template used after failed research verification.
 */
export const DEFAULT_RESEARCH_REPAIR_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Full document before research

{{source}}

## Previous research output

{{executionStdout}}

## Previous verification verdict

{{verificationResult}}

## Last validation error

{{lastValidationError}}

## Phase

Repair the research output so it satisfies verification.

Use the verifier failure reason as the authoritative target for this retry.
Address that failure directly while preserving all required safety constraints.

Produce a complete corrected Markdown document that:

- Preserves checkbox states for existing tasks.
- Does not introduce new unchecked TODO items.
- Preserves original intent semantically.
- Keeps the document useful for planning.
- Improves enrichment quality where missing.

Retry enrichment quality and structure; do not fall back to stripping context.
Do not relax or bypass safety constraints to make verification pass.

Return the full corrected Markdown document and nothing else.
{{traceInstructions}}
`;

/**
 * Default research-resolve template used when research repair attempts are exhausted.
 */
export const DEFAULT_RESEARCH_RESOLVE_TEMPLATE = `\
${DEFAULT_TEMPLATE_SHARED_PREFIX}
${DEFAULT_TEMPLATE_MEMORY_SECTION}
${DEFAULT_TEMPLATE_VARS_SECTION}

## Full document before research

{{source}}

## Original research output

{{executionStdout}}

## Verification failure

{{verificationFailureMessage}}

## Repair attempt history

{{repairAttemptHistory}}

## Phase

Diagnose why research verification keeps failing.

Return exactly one verdict line on stdout:

- \`RESOLVED: <root cause diagnosis>\`
- \`UNRESOLVED: <why diagnosis is not possible from available context>\`

Output only the verdict line and nothing else.
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

## Output contract (strict)

- Output extracted items only.
- Emit exactly one extracted item per line.
- Preserve discovery order.
- Do not add commentary, headings, labels, code fences, or JSON.
- If no items are found, write an empty file.
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

## Output contract (strict)

- Output extracted items only.
- Emit exactly one extracted item per line.
- Preserve discovery order.
- Do not add commentary, headings, labels, code fences, or JSON.
- If no items are found, return an exactly empty stdout response (no lines, no blank lines, no whitespace-only output).
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

