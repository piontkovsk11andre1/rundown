# md-todo

**A Markdown-native task runtime for agentic workflows.**

`md-todo` turns unchecked Markdown tasks into executable work.

Point it at a file, folder, or glob. It finds the next unchecked TODO, builds a structured prompt from the Markdown context, runs a worker command or inline CLI task, validates the result, optionally corrects it, and only then marks the task complete.

It is not just a todo parser and not just a wrapper around an AI CLI.

It is a small, template-driven execution framework for doing real work directly from Markdown.

---

## Why this exists

Markdown is already where many projects think, plan, and track work.

But most Markdown TODOs are passive. They describe work, yet nothing happens until someone manually copies context into a terminal, opens an agent, runs commands, checks results, and edits the checkbox.

`md-todo` closes that gap.

It treats Markdown as an executable workflow surface:

- the task lives in Markdown,
- the surrounding document becomes context,
- the worker command does the work,
- validation decides whether the task is truly done,
- correction retries when needed,
- and the checkbox changes only after success.

---

## The idea in 30 seconds

Given a document like this:

```md
# Sprint Notes

- [x] Confirm the release checklist
- [ ] Add Windows setup guidance to the docs
- [ ] cli: npm test
```

Run:

```bash
md-todo run docs/ -- opencode run
```

`md-todo` will:

1. scan the Markdown source,
2. find the next unchecked task,
3. render a task prompt from the document up to that task,
4. run the worker,
5. validate the outcome,
6. optionally correct and retry,
7. then check the box only if validation passes.

---

## What makes it different

### Markdown-native

The workflow begins where the work is already described.

### Deterministic

It picks the next task in a predictable way and supports explicit sorting.

### Template-driven

The execution, validation, and correction behavior live in repository-local Markdown templates.

### Agent-friendly and CLI-friendly

Tasks can be handled by an external worker such as `opencode`, or executed directly as inline CLI tasks.

### Safe completion model

A task is not considered done just because a command ran. It must validate.

---

## How it works

`md-todo` has three phases:

### 1. Execute

The tool finds the next unchecked task and renders `.md-todo/task.md`.

That rendered prompt is passed to a worker command such as:

```bash
md-todo run roadmap.md -- opencode run
```

### 2. Validate

After execution, `md-todo` renders `.md-todo/validate.md`.

Validation produces a task-specific sidecar file next to the source document, for example:

```text
Tasks.md.3.validation
```

If that file contains exactly `OK`, the task is considered complete.

If it contains anything else, the task remains unchecked and the file stays as evidence.

### 3. Correct

If validation fails, `md-todo` can render `.md-todo/correct.md` and run a correction pass.

Then it validates again.

This loop can run multiple times until the task validates or retries are exhausted.

---

## Project-local templates

The workflow is configured with Markdown templates stored in the repository:

```text
.md-todo/
  task.md
  validate.md
  correct.md
  vars.json
```

This keeps the system readable, versionable, and close to the project itself.

You can also inject extra template variables from the CLI with repeatable `--var key=value` flags or load them from a JSON file with `--vars-file`. Those values are available in `task.md`, `validate.md`, and `correct.md` as `{{key}}`.

```bash
md-todo run roadmap.md --var branch=main --var ticket=ENG-42 -- opencode run
md-todo run roadmap.md --vars-file .md-todo/vars.json --var ticket=ENG-42 -- opencode run
md-todo run roadmap.md --vars-file -- opencode run
```

When `--vars-file` is used without a path, `md-todo` loads `.md-todo/vars.json`.

When both are provided, direct `--var` entries override values loaded from `--vars-file`.

### `task.md`
Defines how the worker should perform the task.

### `validate.md`
Defines how completion should be judged.

### `correct.md`
Defines how to repair a failed attempt.

This makes `md-todo` feel less like a hardcoded integration and more like a small agentic framework you shape per repository.

---

## Sources and task selection

`md-todo` can scan:

- a single Markdown file,
- a directory,
- or a glob such as `notes/**/*.md`.

Supported task forms include standard Markdown task list syntax:

- `- [ ] task`
- `* [ ] task`
- `+ [ ] task`

Nested tasks are supported.

By default, files are processed with human-friendly `name-sort`, which works well for document sets like:

- `01. Idea.md`
- `02. Plan.md`
- `23. Adding Feature.md`

Optional sort modes:

- `none`
- `old-first`
- `new-first`

Inside each file, tasks are scanned in document order.

---

## Two kinds of tasks

### Agent tasks

Normal Markdown tasks are sent to the worker command.

```md
- [ ] Rewrite the opening section so the README is clearer and more confident
```

### Inline CLI tasks

A task can also explicitly ask `md-todo` to run a command directly.

```md
- [ ] cli: npm test
- [ ] cli: node scripts/build-index.js
```

If a CLI command is written in a saved Markdown document, that is treated as intentional permission to execute it.

---

## Runner modes

`md-todo` separates task selection from runner launch behavior.

### `wait`
Launch the runner and wait for it to finish.

This is the default and works best with validation and correction.

### `tui`
Launch an interactive terminal UI runner, let the user steer it, then continue the workflow after exit.

This is especially useful with tools like `opencode`:

1. `md-todo` selects the task,
2. renders the prompt,
3. launches `opencode`,
4. you inspect and steer the session,
5. you quit,
6. `md-todo` resumes validation and correction.

### `detached`
Start the runner without waiting.

This is possible, but weaker for immediate validation.

---

## Prompt transport

Rendered prompts can be passed to the worker in different ways.

### `file` (default)
Write the rendered prompt to a temporary Markdown file and pass that file to the runner.

This is the most robust option, especially on Windows, where quoting and long command lines become fragile.

For `opencode`, `file` transport attaches the generated Markdown file and uses a short bootstrap message instead of pushing the entire rendered prompt through command-line arguments.

### `arg`
Pass the prompt as command arguments.

Useful for smaller prompts, but less reliable for large Markdown context.

---

## OpenCode example

A practical default integration looks like this:

- `wait` mode → `opencode run`
- `tui` mode → `opencode`
- prompt transport → `file`

In `wait` mode, `md-todo` attaches the rendered prompt file to `opencode run` and sends a short instruction telling it to read the attachment first.

This gives a clean workflow:

```bash
md-todo run "notes/**/*.md" -- opencode run
```

Or an interactive handoff:

```bash
md-todo run roadmap.md --mode tui -- opencode
```

---

## Validation sidecar files

Validation should be inspectable.

Instead of trusting terminal output alone, `md-todo` uses task-specific sidecar files such as:

```text
Tasks.md.3.validation
```

Rules:

- `OK` means the task is complete
- anything else means validation failed
- on success, the file is removed
- on failure, it stays for inspection

This gives the workflow a concrete artifact instead of relying on vague free-form output.

---

## Example repository shape

```text
.
├─ .md-todo/
│  ├─ task.md
│  ├─ validate.md
│  └─ correct.md
├─ README.md
├─ roadmap.md
└─ docs/
   ├─ 01. Idea.md
   └─ 02. Plan.md
```

---

## CLI

### `md-todo run <source> -- <command>`

Find the next unchecked task and execute it.

```bash
md-todo run roadmap.md -- opencode run
md-todo run docs/ -- opencode run
md-todo run "notes/**/*.md" -- opencode run
```

**PowerShell users:** PowerShell 5.1 strips `--` from arguments. Use the `--worker` flag instead:

```powershell
md-todo run docs/ --worker opencode run
```

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `--worker <command...>` | Worker command (alternative to `-- <command>`) | — |
| `--mode <mode>` | `wait`, `tui`, or `detached` | `wait` |
| `--transport <transport>` | `file` or `arg` | `file` |
| `--sort <sort>` | `name-sort`, `none`, `old-first`, `new-first` | `name-sort` |
| `--validate` | Run validation after execution | off |
| `--retries <n>` | Max correction attempts on failure | `0` |
| `--dry-run` | Show what would run without executing | off |
| `--print-prompt` | Print the rendered prompt and exit | off |
| `--vars-file [path]` | Load extra template variables from a JSON file, defaulting to `.md-todo/vars.json` | — |
| `--var <key=value>` | Extra template variable, repeatable | — |

### `md-todo next <source>`

Show the next unchecked task without executing it.

```bash
md-todo next docs/
```

### `md-todo list <source>`

List all unchecked tasks across the source.

```bash
md-todo list .
md-todo list --all roadmap.md
```

### `md-todo init`

Create a `.md-todo/` directory with default templates.

```bash
md-todo init
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Task completed successfully |
| `1` | Execution error |
| `2` | Validation failed |
| `3` | No tasks found |

---

## Installation

From source today:

```bash
npm install -g .
```

Planned npm package:

```bash
npm install -g @p10i/md-tool
```

Or use it directly:

```bash
npx md-todo run docs/ -- opencode run
```

---

## Status

`md-todo` is a public, release-quality CLI ready for GitHub and being polished for npm release.

Built with TypeScript, AST-based Markdown parsing, and a clean modular architecture.

---

## Current polish targets

- [x] AST-based Markdown task parsing
- [x] deterministic task indexing and sorting
- [x] repository-local Markdown templates
- [x] runner execution modes (wait, tui, detached)
- [x] prompt transport (file, arg)
- [x] inline CLI task execution
- [x] validation sidecar files
- [x] auto-correction loop with retries
- [x] clear exit codes
- [ ] broader `opencode` integration testing
- [ ] npm packaging and release flow

---

## Philosophy

Markdown is already a lightweight planning language.

`md-todo` turns it into a runtime.

That is the whole point.
