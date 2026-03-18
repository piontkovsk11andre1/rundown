# md-todo

`md-todo` is a CLI tool that executes work from Markdown TODOs.

## Concept

The tool takes:

- a source to scan, such as a file, a directory, or a glob,
- the command that should process the next TODO,
- and optional validation after execution.

Examples of sources:

- a single file,
- a folder,
- or a wildcard such as `notes/**/*.md`.

The basic idea is simple:

- scan Markdown files,
- find the next unchecked TODO,
- build a prompt from the document,
- run the chosen command,
- optionally validate the result,
- and only then mark the task as done.

The prompt should contain the current Markdown file only up to the position of the selected TODO. This keeps the worker focused on the current task and hides later unfinished items.

## Markdown task forms

The tool should recognize standard Markdown task list forms, regardless of which list marker is used.

Unchecked tasks should include forms such as:

- `- [ ] task`
- `* [ ] task`
- `+ [ ] task`

Checked tasks should include forms such as:

- `- [x] done`
- `* [x] done`
- `+ [X] done`

The important part is the checkbox itself, not the bullet character.

Nested task items should work as well. Indented Markdown task lists are still valid tasks and should be detected normally.

Markdown parsing should be robust enough to avoid false task detection inside fenced code blocks and other non-task structures.

For this product, Markdown should be parsed from an AST rather than treated as loose line matching. Detection and task selection should come from the parsed document structure, while final checkbox updates should still preserve the original source formatting.

## Command shape

The command model should separate:

- where to search for tasks,
- from what command should handle them.

The main syntax direction is:

`md-todo run <source> -- <command>`

For PowerShell compatibility, the worker can also be specified with `--worker`:

`md-todo run <source> --worker <command...>`

Examples:

- `md-todo run roadmap.md -- opencode run`
- `md-todo run docs/ -- opencode run`
- `md-todo run "notes/**/*.md" -- opencode run`
- `md-todo run docs/ --worker opencode run` (PowerShell-safe)

The part before `--` belongs to `md-todo`.
The part after `--` is the external command that performs the task.
The `--worker` flag is equivalent and takes precedence if both are provided.

## Runner execution mode

The tool should separate task selection from runner launch behavior.

Execution mode should be optional and should support three conceptual modes:

- `wait` — launch the runner and wait for it to exit,
- `tui` — open the runner interactively and return when the user exits it,
- `detached` — start the runner without waiting.

The default should be `wait`.

This works best with validation and correction because `md-todo` knows when execution has actually finished.

`tui` is useful for tools like `opencode` when the user wants to enter an interactive session and come back to validation afterward.

In this mode, `md-todo` remains the outer workflow.

The expected lifecycle is:

1. `md-todo` selects the next task,
2. renders the task prompt,
3. launches the runner in TUI mode with that prepared context,
4. the user inspects, steers, and works inside the TUI,
5. the user exits the TUI,
6. control returns to `md-todo`,
7. validation continues,
8. and correction may run afterward if needed.

This makes TUI mode a temporary interactive phase inside a larger automated task workflow, not a separate disconnected action.

`detached` is possible, but it is weaker for immediate validation and should be treated as a more advanced mode.

When detached mode is used, the tool should keep the staged runtime artifacts on disk, skip immediate validation/correction, and leave the task unchecked.

## Prompt transport

The tool should also separate how the prompt is delivered to the external runner.

The main prompt transport options are:

- `arg` — pass prompt content as command arguments,
- `file` — write the rendered prompt to a Markdown file under `.md-todo/runs/` and pass that file to the runner.

The default should be `file`.

This is especially important on Windows, where large prompts and shell quoting become fragile.

Using a runtime Markdown file is more robust for long prompts, template output, code blocks, and paths with quotes.

For `opencode run`, `file` transport should avoid passing the full rendered multiline prompt as a positional argument. Instead, it should attach the rendered Markdown file and use a short bootstrap instruction that tells the runner to read that attachment first.

The runtime artifact directory should also be able to preserve prompts, captured output where available, and run metadata. Cleanup should be the default, with an explicit CLI option to keep those artifacts for inspection.

The CLI should also expose a small artifact-management command so users can inspect saved runs, print them as structured JSON, filter failed runs, open a saved run folder by id or `latest`, and prune `.md-todo/runs/` when needed, including failed-only cleanup.

## OpenCode integration direction

For `opencode`, the practical direction is:

- `opencode` by itself opens the TUI,
- `opencode run` is the non-interactive mode and waits for completion.

So a good default mapping is:

- `wait` mode → use `opencode run`,
- `tui` mode → use `opencode`,
- prompt transport default → `file`.

For `opencode`, attaching the rendered Markdown prompt as a file is a more reliable default than forcing the entire prompt through command-line arguments.

## Task selection and sorting

The next task should be selected in a predictable way.

The basic flow is:

1. resolve the source into matching Markdown files,
2. sort the files,
3. scan each file from top to bottom,
4. select the first runnable unchecked task.

A task is runnable when it is unchecked and has no unchecked descendants. This means child tasks must be completed before their parent becomes eligible for execution.

This child-before-parent rule ensures that planned subtasks are always processed first, and the parent task only runs after all its children are done.

The default sorting mode should be `name-sort`.

`name-sort` should be human-friendly natural name ordering, so numbered files like `2. X.md` come before `10. Y.md`.

Optional sorting modes:

- `none` — do not apply extra sorting and use the matcher order as-is,
- `old-first` — oldest files first by creation time,
- `new-first` — newest files first by creation time.

This makes file ordering part of the workflow, which is especially useful for numbered Markdown files such as `23. Adding Feature.md`.

## Two kinds of TODOs

There are two conceptual kinds of unchecked TODO items:

1. Agent task
	- a normal TODO written as an instruction
	- handled by the external command

2. Inline CLI task
	- a TODO that explicitly contains a command to execute directly
	- for example: `cli: npm test`

Inline CLI execution is a first-class feature.

If a command is written in a saved Markdown document, that should be treated as intentional permission to execute it. The tool should not interrupt the flow with an extra access prompt just because the task is an inline CLI command.

## Planning

A task can be decomposed into subtasks before execution.

The `plan` command takes a source (file, directory, or glob) and optionally a specific task via `--at file:line`. It renders the planner template, runs a worker command, and inserts the resulting subtask items as nested children under the selected parent task.

The planner worker should return only unchecked Markdown task items. These are parsed and inserted directly below the parent task line, indented one level deeper.

After planning, the parent task is blocked from execution until all its new children are completed, because of the child-before-parent selection rule.

The `--at file:line` argument uses the 1-based line number from the source file. This is more stable than a task index, because inserting subtasks renumbers downstream task indices but does not change line numbers of earlier tasks.

## Templates

The tool should support Markdown templates instead of raw built-in prompt strings.

There are four templates:

- an execute template,
- a verify template,
- a repair template,
- and a planner template.

These should live in a hidden project folder:

- [.md-todo/execute.md](.md-todo/execute.md)
- [.md-todo/verify.md](.md-todo/verify.md)
- [.md-todo/repair.md](.md-todo/repair.md)
- [.md-todo/plan.md](.md-todo/plan.md)

Legacy aliases should remain supported for backward compatibility:

- [.md-todo/task.md](.md-todo/task.md) as execute template,
- [.md-todo/validate.md](.md-todo/validate.md) as verify template,
- [.md-todo/correct.md](.md-todo/correct.md) as repair template.

This keeps the project prompt-driven, easy to edit, and easy to version.

The final task prompt should be built from three layers:

1. instructions from the execute template,
2. document context from the Markdown file,
3. the exact TODO being processed.

If project templates do not exist, `md-todo` can fall back to built-in defaults.

The CLI should also allow repeatable extra template variables such as `--var branch=main` or `--var ticket=ENG-42`, plus loading them from a JSON file with `--vars-file`. If `--vars-file` is passed without a path, it should default to `.md-todo/vars.json`. Those values should be available to all templates as `{{branch}}`, `{{ticket}}`, and similar placeholders. If both sources are provided, direct CLI `--var` entries should override file-loaded values.

## Behavior

- A TODO item may contain either:
	- plain instructions for an agent, or
	- a CLI command to be executed directly by `md-todo` instead of the agent.
- For a normal task, `md-todo` should render the execute template and pass the result to the external command.
- Verification is a second step, separate from execution, and should be on by default.
- With default run behavior (or explicit `--verify`), after the task is processed, `md-todo` should render the verify template and ask whether the task is truly complete.
- With `--no-verify`, execution should run without the verification step.
- With `--only-verify`, `md-todo` should skip the task execution step and run verification directly against the selected unchecked task.
- If verification fails and a repair pass is enabled, `md-todo` should run repair, then verify again.
- This fix-and-validate cycle may be repeated multiple times, controlled by a CLI argument.
- Repair should remain disabled by default when retries are `0`, and the CLI may also expose an explicit way to suppress repair even when retries are configured.
- The worker must not mark the Markdown TODO as complete on its own by flipping `[ ]` to `[x]` or otherwise editing the task item for completion tracking.
- The worker may edit the Markdown source file only when the task itself genuinely requires changes there, not as a way to self-certify completion.
- Only if validation confirms completion should the tool mark the TODO as checked.
- If validation does not confirm completion, the TODO should remain unchecked.

Legacy flag aliases should remain supported:

- `--validate` as alias for `--verify`,
- `--no-validate` as alias for `--no-verify`,
- `--only-validate` as alias for `--only-verify`,
- `--no-correct` as alias for `--no-repair`.

## Validation

Validation should not be a simple flag that blindly checks the box.

It should be a separate decision step that evaluates whether the task was actually completed.

Conceptually, validation may inspect:

- the original TODO,
- the Markdown file after execution,
- and possibly the command output.

The default validation flow should use a sidecar file written next to the Markdown source.

The sidecar must be task-specific, not just file-specific. A task index is needed so multiple TODOs in the same document can be validated independently.

For example, a file such as [Tasks.md](Tasks.md) may produce a validation file like [Tasks.md.3.validation](Tasks.md.3.validation), where `3` is the selected task index in that document.

The validator should write one of these outcomes into that file:

- `OK`
- or a short reason why the task is still not complete.

If the validation file contains exactly `OK`, the task is considered complete.

If validation succeeds:

- `md-todo` should mark the TODO as checked,
- and remove the validation file.

If validation fails:

- the TODO should remain unchecked,
- and the validation file should remain for inspection.

## Auto-correction

Auto-correction extends validation with a repair loop.

The flow becomes:

1. run the task,
2. validate it,
3. if invalid, run the corrector,
4. validate again.

If the corrector succeeds, validation will eventually produce `OK` and the task can be checked.

If the corrector cannot fix the task, the validation file remains not `OK`, and the TODO stays unchecked.

The number of correction attempts should be controllable with a CLI argument so the user can allow zero, one, or several repair passes.

## Near-term plan

This should be built as a complete `1.0` product, not as a reduced MVP.

The goal is to publish a full, polished release to npm with the core behavior already in place:

- Markdown AST-based task detection,
- source selection and sorting,
- runner execution modes,
- template-driven execution,
- validation sidecar files,
- correction retries,
- inline CLI tasks,
- and professional documentation.