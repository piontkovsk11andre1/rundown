# rundown

**Markdown is no longer where work waits. It is where work runs.**

`rundown` is a harness-agnostic agentic framework that treats a Markdown document as a managed workload.

Write context. Write tasks. Run the file.

Each unchecked checkbox becomes an exact unit of work with:

- execution,
- verification,
- repair when verification fails,
- planning when a task is still too large,
- and artifacts that make the whole run traceable and observable.

This is the missing lens between broad AI capability and precise delivery. A model can generate code, documents, fixes, and plans. `rundown` turns that raw capability into work that is bounded, reviewable, repeatable, and hard to fake.

```md
# Release prep

Context: this branch is stabilizing the release candidate.

- [x] Confirm the release branch
- [ ] Rewrite the README opening around the new product position
- [ ] cli: npm test
- [ ] Verify the installation flow on Windows PowerShell
```

```bash
rundown run . -- opencode run
```

That is not a TODO list anymore.
It is a program.

## Why `rundown` exists

Most AI workflows still break at the handoff.

You describe work in Markdown.
The agent works somewhere else.
Verification happens in your head.
History is partial.
Recovery is fuzzy.

The result is familiar: things look done before they are done.

`rundown` fixes that by making the checkbox a contract instead of a hope. A task is not complete because the agent said so. A task is complete because the work was executed, verified, and only then marked done.

## The Mental Model

Think of `rundown` as a runtime for Markdown-defined work.

1. A Markdown file holds the context and the tasks.
2. `rundown` finds the next ready unchecked task deterministically.
3. It builds a prompt from the surrounding context and your repository-local templates.
4. It sends that work to any CLI-shaped worker, runs an inline `cli:` task directly, or delegates a `rundown:` task to a nested `rundown run`.
5. It verifies the result in a separate pass.
6. If verification fails, it runs a repair loop.
7. Only a verified task earns a checked box.

That gives you a new workload primitive: not a ticket, not a chat transcript, not a fragile prompt, but a visible unit of intent that can be executed with quality gates.

## Quick Start

Install:

```bash
npm install -g @p10i/rundown@rc
```

Initialize the repository-local workflow files:

```bash
rundown init
```

Runtime commands (`run`, `plan`, `reverify`, etc.) discover `.rundown/` by walking upward from your current directory (or from the source Markdown file location when applicable) until one is found. Use `--config-dir <path>` to bypass discovery and point to an explicit config directory.

This creates:

```text
.rundown/
  execute.md
  verify.md
  repair.md
  plan.md
  trace.md
  vars.json
  config.json
```

`rundown init` now writes both `.rundown/vars.json` and `.rundown/config.json` as empty JSON objects (`{}`).

Because the default config is empty, worker-required commands (`run`, `plan`, `discuss`, `research`, `reverify`) need an explicit worker command until you configure one in `.rundown/config.json`:

```bash
rundown run roadmap.md -- opencode run
# or
rundown run roadmap.md --worker "opencode run --file $file"
```

Add lockfiles to your repo ignore rules so runtime file locks are never committed:

```gitignore
**/.rundown/*.lock
```

Run the next task from a file, directory, or glob:

```bash
rundown run roadmap.md -- opencode run
rundown run docs/ -- opencode run
rundown run "notes/**/*.md" -- opencode run
```

`rundown run` and `rundown plan` use file-level lockfiles while they operate on a source Markdown file. The lock is held for the full command duration so concurrent edits or concurrent rundown runs against the same file fail fast instead of corrupting task selection/checking.

If a process crashes and leaves a stale lock, recover with:

```bash
rundown unlock roadmap.md
# or bypass stale lock detection for this invocation
rundown run roadmap.md --force-unlock -- opencode run
```

PowerShell-safe worker form:

```powershell
rundown run docs/ --worker "opencode run --file $file"
```

Useful first commands:

```bash
rundown next docs/
rundown list docs/
rundown log --revertable --limit 10
rundown research roadmap.md -- opencode run
rundown plan roadmap.md --scan-count 3 -- opencode run
rundown reverify -- opencode run
rundown revert --dry-run --worker "opencode run --file $file"
rundown revert --method reset --force --run latest
rundown start "Ship a migration-driven auth flow" --dir ./predict-auth -- opencode run
rundown migrate --dir ./predict-auth/migrations -- opencode run
rundown migrate snapshot --dir ./predict-auth/migrations -- opencode run
rundown test --dir ./predict-auth/specs -- opencode run
rundown undo --last 1 -- opencode run
```

Note: `rundown revert` only works for tasks originally executed with both `--commit` and `--keep-artifacts`.

## Prediction workflow commands

`rundown` also supports a migration-style prediction loop for long-horizon planning:

- `start` scaffolds a prediction project with `Design.md`, `AGENTS.md`, `migrations/`, `specs/`, and `.rundown/`.
- `migrate` generates the next migration or a satellite artifact (`context`, `snapshot`, `backlog`, `review`, `user-experience`).
- `undo` semantically reverses previously completed work from task artifacts (AI-level undo, not git-commit revert).
- `test` verifies spec assertions against the predicted migration state (design + migration context), not the current implementation files.

Naming convention used by prediction migrations:

- migration files: `0007-implement-feature.md`
- satellite files: `0007--snapshot.md`

This double-dash split is intentional: single dash means migration step, double dash means satellite artifact at that migration position.

Plan migration note: `rundown plan` now operates on the entire markdown file and no longer supports `--at file:line` task targeting.

## Install Into Any Agent Harness

If you want an agent to set up `rundown` for the current repository and wire the workflow into the right instruction entrypoint, use this prompt.

Copy and paste it into any agent harness:

```text
Set up this repository to use rundown as the default Markdown task runtime.

Your job:
1. Inspect the workspace and determine whether rundown is already installed and initialized.
2. If rundown is missing, install or update `@p10i/rundown@rc` using the most appropriate method for this repository and environment.
3. If `.rundown/` is missing, run `rundown init`.
4. Before changing any workflow or agent-instruction files, ask me this exact question:
   "Do you want me to reconfigure this workspace/directory into a rundown-based flow for your agent harness?"
5. If I say yes, inspect the repository and choose the best existing instruction entrypoint for this harness. Prefer updating an existing file rather than creating a new one. Examples may include `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, repository instruction files, or another harness-specific entrypoint.
6. Update that entrypoint so agents are guided to use rundown efficiently. The instructions should be concise and practical, including:
   - use Markdown task files as the source of truth for work,
   - use `rundown next`, `rundown list`, `rundown plan`, `rundown run`, `rundown reverify`, and `rundown revert` when appropriate,
   - do not manually check boxes before verification succeeds,
   - prefer repository-local `.rundown/` templates as the control surface,
   - keep artifacts when debugging or auditing a run.
7. If no suitable instruction entrypoint exists, explain the best options and ask for confirmation before creating one.
8. At the end, summarize what you installed, what you initialized, what file you updated, and how to run the first task.

Constraints:
- Do not assume a specific harness file exists.
- Do not overwrite unrelated instructions.
- Keep the guidance aligned with the current repository structure.
- Ask before making workflow-entrypoint changes.
```

## Why This Hits

`rundown` is simple where it should be simple and flexible where it matters.

The interface is boring on purpose: a Markdown file, a checkbox, a command.

The behavior behind it is not.

- It is harness-agnostic: use OpenCode, Claude, Aider, or another CLI worker.
- It is deterministic: task selection is sorted and predictable.
- It is verification-first: execution alone never counts as completion.
- It is template-driven: each repository defines how work should be executed, checked, repaired, and planned.
- It is context-aware: `cli` fenced blocks can run shell commands and inject `<command>`/`<output>` context directly into prompts.
- It is inspectable: prompts, logs, metadata, and traces can be preserved as run records.
- It is operationally useful: tasks can trigger commits, post-success hooks, failure hooks, and historical re-verification.

That combination matters because AI is strongest when it is focused. `rundown` narrows a large, fuzzy capability surface into exact work units that can survive interruption, review, reruns, and changing standards.

## How The Loop Works

### 1. Select

`rundown` scans a file, directory, or glob, sorts the files, walks tasks in document order, and picks the first ready unchecked task.

Nested tasks are real tasks. A parent task stays blocked while any descendant task remains unchecked.

### 2. Execute

The selected task is rendered through `.rundown/execute.md` together with the document context, task metadata, and any custom variables.

Normal tasks go to your worker.
Tasks that start with `cli:` run directly.
Tasks that start with `rundown:` delegate to a nested `rundown run <file> [args...]`.

### 3. Verify

Verification is a separate pass with a stricter contract.

The verifier returns either:

- `OK`
- `NOT_OK: <short reason>`

That result is persisted by `rundown` as a task-specific validation sidecar. A task only completes when verification says `OK`.

### 4. Repair

If verification fails, `rundown` renders `.rundown/repair.md`, runs another attempt, and verifies again.

This makes failure part of the workload model instead of an untracked side effect.

### 5. Research

When a feature document is still thin (for example title + intent only), run `research` first.

`rundown research` reads the full document and rewrites it with richer implementation context, constraints, and planning scaffolding while preserving author intent.

`research` is single-pass in this iteration and does not support `--scan-count` convergence loops.

Research is intentionally a prep phase:

```bash
rundown research docs/release-plan.md -- opencode run
rundown plan docs/release-plan.md --scan-count 3 -- opencode run
```

It does not decompose work into TODOs itself; that remains the `plan` phase.

### 6. Plan

When implementation intent is spread across a full document, `rundown plan` scans that markdown file and appends missing actionable TODOs using `.rundown/plan.md`.

If the document has no TODOs yet, `plan` creates an initial actionable set first, then runs iterative clean-session scans (`--scan-count`, default `3`) until no additional TODOs are proposed or the scan cap is reached.

Updates are append-only for safety: existing TODO text is preserved while missing work is added deterministically.

Practical examples:

```bash
# Bootstrap a spec with no TODOs
rundown plan docs/release-plan.md --scan-count 3 -- opencode run

# Enrich an existing TODO list with missing implementation steps
rundown plan docs/migration.md --scan-count 2 -- opencode run
```

### 7. Reverify

`rundown reverify` re-runs verify and optional repair against a previously completed task from saved run metadata.

Use it when templates changed, when you want a pre-release confidence check, or when you need to audit whether an already-checked task still holds up.

## The Control Surface Lives In The Repo

`rundown` does not hide its behavior behind a hosted control plane or a vendor-specific workflow DSL.

The system is shaped by files that live next to your code:

- `.rundown/execute.md`
- `.rundown/verify.md`
- `.rundown/repair.md`
- `.rundown/plan.md`
- `.rundown/research.md`
- `.rundown/trace.md`
- `.rundown/vars.json`

That means the workflow is:

- visible,
- versioned,
- reviewable,
- and easy to adapt per repository.

You can inject repository context with `--var key=value` or `--vars-file`, tune prompt behavior per phase, and preserve a shared prefix across templates so the model sees a stable structure.

## Observable By Default

When you keep artifacts, each execution can produce a run folder under `.rundown/runs/` with the prompt, stdout, stderr, metadata, and optional trace output.

That gives you a concrete record of what happened:

- what task was selected,
- what context was sent,
- what the worker returned,
- how verification evaluated it,
- whether repair was needed,
- and what historical task `reverify` is targeting.

This matters for debugging, trust, and repeatability. The workflow is not a black box chat session. It leaves evidence.

In addition to per-run artifacts, rundown defines a cumulative append-only JSONL log at `.rundown/logs/output.jsonl`. It is designed as a single stable scrape target for Promtail and other line-oriented log shippers.

When trace is enabled, rundown also mirrors every per-artifact trace event (including LLM-stage analysis events) into `.rundown/logs/trace.jsonl` so trace telemetry can be consumed from one cumulative JSONL stream.

The file is never truncated by normal execution flow: each CLI invocation appends new lines, preserving prior history across runs and commands. It captures normal application output plus CLI/framework-level error paths in the same stream, and stores rendered messages as plain text (no ANSI color codes).

First-iteration constraints: this sink currently has no built-in rotation or compression policy, and rundown does not backfill historical output from older runs into this file. Treat it as an append-only stream and use external tooling (for example OS log rotation or log pipeline retention controls) to manage growth.

Each log line is one JSON object with stable top-level fields:

- `ts` — event timestamp (ISO-8601 UTC)
- `level` — severity (`info`, `warn`, `error`)
- `stream` — logical output stream (`stdout` or `stderr`)
- `kind` — output event kind label
- `message` — plain-text rendered payload
- `command` — CLI command name for the invocation
- `argv` — CLI argument vector for the invocation
- `cwd` — invocation working directory
- `pid` — process ID
- `version` — rundown CLI version
- `session_id` — invocation-scoped correlation ID

## Flexible In Practice

You can keep `rundown` minimal:

```bash
rundown run roadmap.md -- opencode run
```

Or you can turn it into a more operational loop:

```bash
rundown run roadmap.md --show-agent-output --worker "opencode run --file $file"
rundown run roadmap.md --all --commit --on-complete "git push" -- opencode run
rundown run roadmap.md --clean --all --worker "opencode run --file $file"
rundown run roadmap.md --keep-artifacts --worker "claude -p $bootstrap"
rundown reverify --no-repair -- opencode run
```

Useful capabilities that stay out of the way until you need them:

- run all remaining tasks sequentially with `--all`
- reset checklist state with `--redo` (before run), `--reset-after` (after run), or `--clean` (both)
- expand `cli` fenced blocks in task markdown and templates, or disable execution with `--ignore-cli-block`
- set per-command `cli` block timeouts with `--cli-block-timeout <ms>`
- show worker stdout/stderr for execute/verify/plan with `--show-agent-output` (default: off; output hidden otherwise)
- use interactive sessions with `--mode tui`
- use worker patterns to choose prompt delivery (`$file` direct path or `$bootstrap` instruction text)
- auto-commit completed work with a task-derived message
- trigger hooks on success or failure
- inspect or clean execution records with `rundown artifacts`

## A Better Default For AI Work

There is a lot of power in modern models.
There is still not enough structure around how that power is applied.

`rundown` gives you a narrow waist for the whole workflow:

- Markdown describes the work,
- templates define the method,
- workers perform the action,
- verification decides whether it counts,
- and artifacts preserve what happened.

That is why the result feels crisper. The agent is no longer improvising across an open field. It is moving through bounded, named, testable units of work.

## Docs

- [docs/overview.md](docs/overview.md) for the runtime model, task selection, execution modes, and verification behavior
- [docs/cli.md](docs/cli.md) for commands, flags, and shell-specific usage
- [docs/templates.md](docs/templates.md) for template roles, variables, and prompt construction
- [docs/examples.md](docs/examples.md) for practical execution patterns

## Status

`rundown` is intentionally small and already useful.

It is not trying to become another orchestration platform.
It is trying to make one workflow precise:

write the task,
run the task,
check the box only when reality agrees.
