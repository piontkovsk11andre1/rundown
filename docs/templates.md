# Templates

`rundown` is template-driven.

Repository-local Markdown templates define how tasks are executed, verified, repaired, and planned.

## Template files

Store templates in `.rundown/`:

```text
.rundown/
  agent.md
  help.md
  execute.md
  research.md
  verify.md
  repair.md
  plan.md
  plan-prepend.md
  plan-append.md
  discuss.md
  discuss-finished.md
  trace.md
  undo.md
  test-materialized.md
  test-future.md
  test-verify.md
  migrate.md
  vars.json
```

### Template files table

| File | Role |
| --- | --- |
| `.rundown/agent.md` | Warmup instructions prepended to root no-argument live help prompts |
| `.rundown/help.md` | Instructions for no-argument live help sessions |
| `.rundown/execute.md` | Instructions for doing the task |
| `.rundown/research.md` | Instructions for enriching document context before planning |
| `.rundown/verify.md` | Instructions for deciding whether the task is truly complete |
| `.rundown/repair.md` | Instructions for fixing a failed attempt |
| `.rundown/plan.md` | Instructions for breaking a task into nested subtasks |
| `.rundown/plan-prepend.md` | Optional advisory guidance for what should appear near the beginning of generated plan tasks |
| `.rundown/plan-append.md` | Optional advisory guidance for what should appear near the end of generated plan tasks |
| `.rundown/discuss.md` | Instructions for interactive task refinement before execution |
| `.rundown/discuss-finished.md` | Instructions shown when a discuss session exits with no in-file edits applied |
| `.rundown/test-materialized.md` | Instructions for `rundown test` materialized mode (present-state validation) |
| `.rundown/test-future.md` | Instructions for `rundown test --future` prediction mode (future-state validation) |
| `.rundown/test-verify.md` | Shared verification instructions used by both `rundown test` modes |
| `.rundown/trace.md` | Instructions for trace-context enrichment output used by preview, plan, and execution flows |
| `.rundown/undo.md` | Instructions for preparing and applying rollback prompts in `rundown undo` |
| `.rundown/migrate.md` | Instructions for migration generation in `rundown migrate` |

## Planner guidance files (optional)

Planner customization can include two optional guidance files:

- `.rundown/plan-prepend.md`
- `.rundown/plan-append.md`

These files are not macro snippets and are not copied literally into TODO output.
They are semantic guidance that influences planner judgment when `rundown plan`
or plan phases in other commands generate missing tasks.

Use them to express intent such as:

- what discovery/setup checks should usually appear early,
- what validation/handoff steps should usually appear late,
- when those patterns should be skipped.

Fallback behavior is safe by default:

- if either file is missing, unreadable, or empty, it is treated as empty guidance,
- planning continues normally with built-in guardrails,
- add-only and convergence rules remain unchanged.

### Good guidance style

Prefer intent-oriented phrasing instead of literal TODO text requirements.

Example `.rundown/plan-prepend.md`:

```md
When changes affect unfamiliar modules, add an early discovery task to inspect current behavior and constraints before implementation.

Skip this when the selected section is purely editorial documentation work.
```

Example `.rundown/plan-append.md`:

```md
If planned tasks modify executable source files, include a final verification task appropriate for the stack (tests, lint, or build).

Do not add release or packaging tasks for local prototypes.
```

### Live help placeholders

When `rundown` launches with no subcommand and opens live help, `.rundown/help.md`
can use these placeholders:

Root no-arg prompt composition contract:

- Root no-arg help composes warmup first, then guidance: `.rundown/agent.md` followed by `.rundown/help.md`.
- `agent.md` is resolved from the active config directory (explicit `--config-dir` or discovered `.rundown/`).
- If `agent.md` is missing, unreadable, or effectively empty, rundown falls back to the built-in `DEFAULT_AGENT_TEMPLATE` warmup text.
- This warmup+help composition is specific to root no-arg help mode and does not change worker-facing prompt contracts for `run`, `plan`, `research`, `reverify`, or `discuss`.

Root help first-response contract:

- The first assistant-visible output for root no-arg help mode must start with the canonical welcome line: "Welcome to rundown. Start with `plan`, `explore`, `run`, or `help`."
- Keep this wording stable (no randomized variants) and emit it once per root session before additional help guidance.

| Placeholder | Description |
| --- | --- |
| `{{cliVersion}}` | Current rundown CLI version. |
| `{{workingDirectory}}` | Current invocation working directory. |
| `{{commandIndex}}` | Concise command reference list (run, call, plan, research, make, do, discuss, reverify, revert, etc.). |
| `{{docsContext}}` | Markdown bullet list of `docs/*.md` files in the current repository, or a fallback status message when unavailable. |

These are additive to standard template placeholders; unresolved placeholders are left as-is.

## Why templates matter

Templates keep workflow behavior close to the repository:

- visible,
- editable,
- versioned,
- and easy to review.

That makes `rundown` feel like a reusable framework instead of a hardcoded integration.

## Prompt construction

For the built-in templates, the prompt layout is intentionally cache-friendly:

1. Markdown context from the source document comes first,
2. then the selected task metadata,
3. then the phase-specific instructions for execute, verify, repair, plan, or discuss.

The same model applies to verification, repair, planning, and discussion with their respective templates.

## Template variables

You can inject additional variables into templates.

Examples:

```bash
rundown run roadmap.md --var branch=main --var ticket=ENG-42 -- opencode run
rundown run roadmap.md --vars-file .rundown/vars.json -- opencode run
rundown run roadmap.md --vars-file -- opencode run
```

When `--vars-file` is used without a path, `rundown` loads `.rundown/vars.json`.

When both are provided, direct `--var` entries override file-loaded values.

These values are available in templates as placeholders such as `{{branch}}` or `{{ticket}}`.

For tool-expansion tasks (`<tool-name>: <payload>` with a matching template in `.rundown/tools/`),
`{{payload}}` is also available and contains the task text after the first `:`.

### Workspace and variables sections in built-in templates

Built-in worker-facing templates include:

- A `## Workspace context` section with first-class runtime fields:
  - `{{invocationDir}}`
  - `{{workspaceDir}}`
  - `{{workspaceLinkPath}}`
  - `{{isLinkedWorkspace}}`
  - `{{workspaceDesignDir}}`
  - `{{workspaceSpecsDir}}`
  - `{{workspaceMigrationsDir}}`
  - `{{workspaceDesignPlacement}}`
  - `{{workspaceSpecsPlacement}}`
  - `{{workspaceMigrationsPlacement}}`
  - `{{workspaceDesignPath}}`
  - `{{workspaceSpecsPath}}`
  - `{{workspaceMigrationsPath}}`
- A `## Variables` section that renders `{{userVariables}}`.

These workspace fields are available in worker-facing prompt paths (`run`, `discuss`,
`plan`, `research`, and `reverify` flows, including execute/verify/repair/resolve
phase prompts when those phases are active).

### Workspace context variable contract

All workspace-context fields are runtime-injected as absolute normalized paths/values:

Placement term contract used across config, CLI docs, and prompt variables:

- `sourcedir`: effective workspace/source directory chosen by command resolution.
- `workdir`: invocation directory where the command was launched.

In non-linked mode, both terms resolve to the same absolute path. In linked mode, they may differ.

| Variable | Meaning |
| --- | --- |
| `{{invocationDir}}` | Absolute directory where the CLI command was invoked. |
| `{{workspaceDir}}` | Absolute effective workspace directory used for execution/source resolution. |
| `{{workspaceLinkPath}}` | Absolute path to `.rundown/workspace.link` when linked workspace mode is active; otherwise empty. |
| `{{isLinkedWorkspace}}` | String boolean: `"true"` when linked mode is active, otherwise `"false"`. |
| `{{workspaceDesignDir}}` | Project-relative design workspace directory from prediction workspace config (default: `design`). |
| `{{workspaceSpecsDir}}` | Project-relative specs workspace directory from prediction workspace config (default: `specs`). |
| `{{workspaceMigrationsDir}}` | Project-relative migrations workspace directory from prediction workspace config (default: `migrations`). |
| `{{workspaceDesignPlacement}}` | Placement mode for design bucket: `sourcedir` or `workdir` (default: `sourcedir`). |
| `{{workspaceSpecsPlacement}}` | Placement mode for specs bucket: `sourcedir` or `workdir` (default: `sourcedir`). |
| `{{workspaceMigrationsPlacement}}` | Placement mode for migrations bucket: `sourcedir` or `workdir` (default: `sourcedir`). |
| `{{workspaceDesignPath}}` | Absolute path to effective design bucket (`workspaceDesignDir` resolved under `workspaceDir` for `sourcedir`, or `invocationDir` for `workdir`). |
| `{{workspaceSpecsPath}}` | Absolute path to effective specs bucket (`workspaceSpecsDir` resolved under `workspaceDir` for `sourcedir`, or `invocationDir` for `workdir`). |
| `{{workspaceMigrationsPath}}` | Absolute path to effective migrations bucket (`workspaceMigrationsDir` resolved under `workspaceDir` for `sourcedir`, or `invocationDir` for `workdir`). |

Fallback semantics are deterministic:

- Non-linked mode: `invocationDir === workspaceDir`, `workspaceLinkPath` is empty,
  and `isLinkedWorkspace` is `"false"`.
- Linked mode: `workspaceDir` resolves to the linked target and may differ from
  `invocationDir`; `workspaceLinkPath` is populated; `isLinkedWorkspace` is `"true"`.
- Stale/broken link targets: values fall back to non-linked semantics so prompts do not
  claim a linked workspace when resolution is invalid.

Placement behavior notes:

- `workspaceDesignPath`, `workspaceSpecsPath`, and `workspaceMigrationsPath` are computed from both configured bucket directory names and bucket placement modes.
- Default placement for all buckets is `sourcedir` when `workspace.placement` keys are omitted.
- Mixed placement is supported and represented explicitly via `workspace*Placement` variables.
- Prompt consumers should treat the resolved `workspace*Path` variables as authoritative instead of recomputing paths.

Workspace-context keys are authoritative runtime fields and cannot be overridden by
user-provided `--var` or `--vars-file` values.

### Placement examples

Mixed placement (non-linked workspace where `invocationDir === workspaceDir`):

| Variable | Example value |
| --- | --- |
| `{{workspaceDesignPlacement}}` | `sourcedir` |
| `{{workspaceSpecsPlacement}}` | `workdir` |
| `{{workspaceMigrationsPlacement}}` | `sourcedir` |
| `{{workspaceDesignPath}}` | `/repo/design` |
| `{{workspaceSpecsPath}}` | `/repo/specs` |
| `{{workspaceMigrationsPath}}` | `/repo/migrations` |

Mixed placement (linked workspace where roots differ):

| Variable | Example value |
| --- | --- |
| `{{invocationDir}}` | `/work/client-a` |
| `{{workspaceDir}}` | `/work/platform-core` |
| `{{workspaceDesignPlacement}}` | `sourcedir` |
| `{{workspaceSpecsPlacement}}` | `workdir` |
| `{{workspaceMigrationsPlacement}}` | `sourcedir` |
| `{{workspaceDesignPath}}` | `/work/platform-core/design` |
| `{{workspaceSpecsPath}}` | `/work/client-a/specs` |
| `{{workspaceMigrationsPath}}` | `/work/platform-core/migrations` |

`{{userVariables}}` is a formatted dump of all extra template variables (merged from
`--vars-file` and `--var`, with `--var` winning on conflicts).

- Non-empty variables render as a `key: value` list.
- When no extra variables are provided, it renders as `(none)`.

This placeholder is available to custom templates as well. If you want the same
visibility in your own template, include a section like:

````md
## Variables

{{userVariables}}
````

## Built-in memory variables

Worker-facing templates receive source-local memory metadata as compact placeholders.

| Variable | Description |
| --- | --- |
| `{{memoryStatus}}` | `available` when source memory metadata is present, otherwise `unavailable`. |
| `{{memoryFilePath}}` | Absolute path to the source-local memory body file. |
| `{{memorySummary}}` | One-line summary from memory index metadata for the source. |
| `{{memoryIndexPath}}` | Absolute path to the source-local memory index file. |
| `{{memoryMap}}` | Compact JSON object containing `status`, `filePath`, `summary`, and `indexPath`. |

Notes:

- Memory variables are additive; custom templates that do not reference them continue to work.
- Rundown does not inline full memory body content into prompts by default.

### Memory storage layout

Memory artifacts are source-local (same directory as the Markdown source):

- Memory body: `<source-dir>/.rundown/<source-basename>.memory.md`
- Memory index: `<source-dir>/.rundown/memory-index.json`

The index is keyed by canonical absolute source path and stores concise per-source metadata used to populate memory placeholders.

### Memory map block example

You can embed a compact map section in custom templates:

````md
## Memory context

- Status: {{memoryStatus}}
- File: `{{memoryFilePath}}`
- Index: `{{memoryIndexPath}}`
- Summary: {{memorySummary}}

```json
{{memoryMap}}
```
````

## Example template content

The examples below show realistic templates you can copy into `.rundown/` and customize.

### `discuss.md`

```md
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}

## Discussion mode

You are in interactive discussion mode.

Goal:
- Help the user refine this task before execution.
- Identify ambiguity, missing constraints, and hidden assumptions.

You may modify the source Markdown file to improve task quality by:
- rewriting the selected task for clarity,
- splitting it into smaller unchecked sub-items,
- adding scoped acceptance criteria,
- tightening vague wording and out-of-date details.

Rules:
- Keep edits focused on this task and its immediate sub-items.
- Preserve Markdown structure and checklist formatting.
- Do not mark any checkbox completed.
- Do not claim implementation is finished in this mode.

Project context:
- Branch: `{{branch}}`
- Ticket: `{{ticket}}`
```

### `execute.md`

```md
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}

## Phase

Execute the selected task.

Project context:
- Branch: `{{branch}}`
- Ticket: `{{ticket}}`

Requirements:
- Implement exactly what the selected task asks for.
- Keep changes focused and production-ready.
- Do not edit the source Markdown checkbox or mark completion manually.
- Keep output concise and include file paths changed.
```

### `verify.md`

```md
{{context}}

---

The Markdown above is the source document up to but not including the selected unchecked task.

## Source file

`{{file}}` (line {{taskLine}})

## Selected task

{{task}}

## Phase

Verify whether the selected task is complete.

Validation steps:
1. Check the current project state (files, tests, output) against the selected task.
2. Decide if the task is complete.

Return your result on stdout as exactly one of:

- `OK`
- `NOT_OK: <short explanation of what is still missing>`

- Do not create or modify verification artifacts directly. `rundown` persists your parsed stdout result in verify-phase runtime artifact metadata.
- Do not modify the source Markdown task file.
- Do not change any checkbox.
```

## Planning output requirements

The planner worker should return only unchecked Markdown task items.

Example:

```md
- [ ] Write the new README opening
- [ ] Add a short Windows example
- [ ] Tighten the installation section
```

`rundown` parses those items and inserts them beneath the selected parent task at one indentation level deeper.

## Verification contract

Verification is intentionally strict.

`rundown` persists the parsed verifier stdout result in verify-phase runtime artifact metadata. If that persisted result contains exactly `OK`, the task is considered complete.

Anything else means the task remains unchecked.

This keeps completion logic explicit and inspectable.

## Command-output blocks

You can place `cli` fenced blocks in both task source Markdown files and `.rundown/` templates.

Syntax:

````md
```cli
cat README.md
git status --short
```
````

Each non-empty, non-comment line is treated as one shell command.

### Execution model

When command execution is enabled, rundown expands each `cli` block into XML before sending prompts to workers.

Source files are expanded before task parsing; templates are expanded after template variables are rendered.

For `run`/`discuss`/`plan`/`reverify`/`research` flows that stage worker input as `prompt.md`, the staged prompt file receives the same expanded XML content. Prompt-file handling is not a separate variant; it uses the same source/template `cli` expansion pipeline and options.

Ordering and failure semantics are unchanged in prompt files:

- commands run in block order,
- failures emit `<command exit_code="...">` with captured output,
- expansion continues after a failed command (non-fatal at source level),
- template-level fatal behavior remains controlled by the existing template failure handlers.

Expanded form:

````md
<command>cat README.md</command>
<output>
...command output...
</output>

<command>git status --short</command>
<output>
...command output...
</output>
````

On command failure, the command tag includes an `exit_code` attribute and output contains stderr:

````md
<command exit_code="1">git show does-not-exist</command>
<output>
fatal: ambiguous argument 'does-not-exist': unknown revision or path not in the working tree.
</output>
````

### CLI flags

- `--ignore-cli-block` skips `cli` block execution entirely and leaves the fenced blocks unexpanded.
- `--cli-block-timeout <ms>` sets per-command timeout in milliseconds (default `30000`; `0` disables timeout).

### Shell behavior

`cli` commands run via Node `spawn(command, { shell: true })`, so execution uses the OS default shell:

- Unix-like systems use `/bin/sh`.
- Windows uses `%ComSpec%` (typically `cmd.exe`).

Write commands with this in mind if your templates or task sources must run cross-platform.
