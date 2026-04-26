# Module map

One-line description of each file in [implementation/src/](../../implementation/src/). Use this as a "where do I look?" index. Detailed contracts live in the topic-specific design docs.

## Top level

| File | Purpose |
|---|---|
| [create-app.ts](../../implementation/src/create-app.ts) | Composition root. Builds the `App` from ports + use-case factories. |
| [index.ts](../../implementation/src/index.ts) | Public package API. |

## `domain/`

### Models and parsing

| File | Purpose |
|---|---|
| `parser.ts` | Parses Markdown into `Task[]` using mdast + GFM task list extension. |
| `task-selection.ts` | Depth-first selection of next runnable task; hierarchy + parent-checked rules. |
| `task-intent.ts` | Classifies tasks into `execute-and-verify` / `verify-only` / `memory-capture` / `tool-expansion` / `fast-execution`. |
| `checkbox.ts` | Pure checkbox state mutation; `resetAllCheckboxes` exported as public API. |
| `todo-lines.ts` | Helpers for inserting and reformatting checkbox lines. |
| `migration-parser.ts` | Parses migration filenames (`N. Title.md`, `N.M Snapshot.md`). |
| `migration-types.ts` | Migration-related types. |
| `prediction-reconciliation.ts` | Reconciles predicted vs materialized state for `test --future`. |
| `metadata-escape.ts` | Escapes metadata strings written into Markdown. |

### Worker and config

| File | Purpose |
|---|---|
| `worker-config.ts` | `WorkerConfig` schema, `resolveWorkerConfig` precedence logic. |
| `worker-pattern.ts` | Parses worker patterns; `$bootstrap` / `$file` / `--prompt=` placeholders. |
| `worker-health.ts` | Health-policy types and predicates. |
| `worker-output-parser.ts` | Extracts structured signals from worker stdout. |
| `harness-preset-registry.ts` | Known harness presets (opencode, claude, gemini, codex, aider, cursor). |
| `agents-template.ts` | `AGENTS.md` content emitter. |

### Templates and vars

| File | Purpose |
|---|---|
| `template.ts` | Template string interpolation engine. |
| `template-vars.ts` | Built-in template variable resolution. |
| `defaults.ts` | Default templates (run prompt, plan prompt, deep plan prompt, …). |

### Tools

| File | Purpose |
|---|---|
| `builtin-tools/index.ts` | Static registry of built-in handlers/modifiers. |
| `builtin-tools/verify.ts` | `verify:` / `confirm:` / `check:` handler. |
| `builtin-tools/include.ts` | `include:` handler — nested rundown delegation. |
| `builtin-tools/for-loop.ts` | `for:` / `each:` / `foreach:` handler. |
| `builtin-tools/parallel.ts` | `parallel:` / `concurrent:` / `par:` handler. |
| `builtin-tools/end.ts` | `optional:` / `skip:` / `end:` / `exit:` / `return:` / `quit:` / `break:` handlers. |
| `builtin-tools/profile.ts` | `profile=name` modifier. |
| `builtin-tools/force.ts` | `force:` modifier (skip repair loop). |
| `builtin-tools/get.ts` | `get:` extraction handler. |
| `builtin-tools/memory.ts` | `memory:` / `memorize:` / `remember:` / `inventory:` handlers (registered dynamically). |
| `builtin-tools/template-tool.ts` | Generic `.md`-file tool handler. |
| `builtin-tools/question.ts` | Interactive question prompt. |
| `builtin-tools/research-output-prompt.ts` | Research output formatting prompt. |

### Trace, runtime, misc

| File | Purpose |
|---|---|
| `trace.ts` | Trace event schema (v1) and event factories. |
| `trace-parser.ts` | Reads back persisted trace files. |
| `trace-statistics.ts` | Aggregations used by inline trace summaries. |
| `run-id.ts` | Run-id generation. |
| `run-options.ts` | `RunTaskOptions` shape. |
| `run-reasons.ts` | Reasons attached to skip/abort outcomes. |
| `cli-block.ts` | `cli:` block recognition and parsing. |
| `cli-timestamp.ts` | Timestamp formatting for CLI logs (local time). |
| `for-loop.ts` | `for:` iteration model. |
| `parallel-group.ts` | Parallel-group construction. |
| `prefix-chain.ts` | Tool prefix chaining (`profile=fast verify:`). |
| `relative-time.ts` | Human-readable durations. |
| `terminal-control.ts` | ANSI sequences. |
| `sorting.ts` | Source-list sort modes (`name-sort`, `none`, `old-first`, `new-first`). |
| `messages.ts` | Localized message catalog. |
| `locale.ts` | Locale resolution helpers. |
| `exit-codes.ts` | Numeric exit codes. |
| `global-output-log.ts` | Global invocation log helpers. |
| `workspace-link.ts` | Workspace-link metadata model. |
| `services/output-similarity.ts` | Levenshtein-style similarity helper. |
| `services/string-utils.ts` | Generic string helpers. |
| `ports/*.ts` | All port interfaces (no runtime). |

## `application/`

(See [layers.md](layers.md) for the high-traffic ones; this is the full list.)

`run-task.ts`, `run-task-execution.ts`, `run-task-iteration.ts`, `run-task-utils.ts`, `run-task-worker-command.ts`, `run-lifecycle.ts`, `task-execution-dispatch.ts`, `task-context-resolution.ts`, `iteration-mode.ts`, `verify-repair-loop.ts`, `repair-template-resolution.ts`, `complete-task-iteration.ts`, `dry-run-dispatch.ts`, `prepare-task-prompts.ts`, `tool-execution.ts`, `cli-block-handlers.ts`, `cached-command-executor.ts`, `git-operations.ts`, `manage-artifacts.ts`, `trace-artifacts.ts`, `trace-enrichment.ts`, `trace-only-enrichment.ts`, `trace-run-session.ts`, `worker-failure-classification.ts`, `worker-health-status.ts`, `resolve-worker.ts`, `runtime-workspace-context.ts`, `workspace-selection.ts`, `workspace-lifecycle.ts`, `prediction-workspace-paths.ts`, `design-context.ts`, `docs-task.ts`, `docs-revision-task.ts`, `discuss-task.ts`, `help-task.ts`, `query-task.ts`, `query-output.ts`, `next-task.ts`, `list-tasks.ts`, `log-runs.ts`, `init-project.ts`, `start-project.ts`, `project-templates.ts`, `localize-project.ts`, `translate-task.ts`, `migrate-task.ts`, `plan-task.ts`, `research-task.ts`, `revert-task.ts`, `reverify-task.ts`, `undo-task.ts`, `unlock-task.ts`, `view-memory.ts`, `validate-memory.ts`, `clean-memory.ts`, `test-specs.ts`, `with-task.ts`, `config-mutation.ts`, `checkbox-operations.ts`.

## `infrastructure/`

`runner.ts`, `inline-cli.ts`, `inline-rundown.ts`, `cli-block-executor.ts`, `verification.ts`, `repair.ts`, `selector.ts`, `sources.ts`, `runtime-artifacts.ts`, `worker-health-store.ts`, `template-vars-io.ts`, `templates-loader.ts`, `planner-io.ts`, `git.ts`, `hooks.ts`, `file-lock.ts`, `file-birthtime.ts`, `cancellable-sleep.ts`, `open-directory.ts`, plus everything under `adapters/` (see [ports-and-adapters.md](ports-and-adapters.md)).

## `presentation/`

`cli.ts`, `cli-command-actions.ts`, `cli-options.ts`, `cli-app-init.ts`, `cli-argv.ts`, `cli-invocation-log.ts`, `cli-invocation-types.ts`, `cli-lock-handlers.ts`, `invocation-workspace-context.ts`, `output-port.ts`, `logged-output-port.ts`, `task-detail-lines.ts`, `intro.ts`, `animation.ts`.
