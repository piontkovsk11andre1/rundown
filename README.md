# rundown

**Your Markdown already describes the work. Now it does the work.**

```
- [x] Confirm the release branch
- [ ] Add Windows setup guidance to the README        ← agent writes it
- [ ] cli: npm test                                   ← runs, verifies, moves on
```

```bash
rundown run docs/ -- opencode run
```

One command. Every unchecked box becomes a real execution: prompted, run, verified, and only then marked complete.

---

## The problem

You plan in Markdown.
Agents work in terminals.
Verification lives in your head.

The gap between *writing down what needs to happen* and *making it happen* is still a copy-paste, tab-switch, manual-check mess — even with great AI tools. The handoff is where work stalls.

## The fix

`rundown` closes the gap. It treats a Markdown checkbox as a **durable contract between intent and execution**:

1. **Find** the next unchecked task.
2. **Build** a prompt from the surrounding document context.
3. **Execute** via a worker (like `opencode`) or an inline `cli:` command.
4. **Verify** the result with a separate validation pass.
5. **Repair** if verification fails — automatically.
6. **Complete** the checkbox only when reality agrees.

A task is not done because a command ran.
A task is done because it *passed*.

---

## What makes this different

**Markdown-native.** No new file format. No YAML config sprawl. The work stays where the thought already lives.

**Validation-first.** Every task gets a verification step. Execution without proof is just hope.

**Template-driven.** Your repo defines its own `execute`, `verify`, `repair`, and `plan` prompts. You control what the agent sees.

**Deterministic.** Task selection is predictable. No surprising reordering, no ambient "intelligence" deciding what to run next.

**Agent-agnostic.** Use `opencode`, `claude`, `aider`, or any CLI-shaped worker. `rundown` doesn't care what does the work — it cares that the work got done.

**Git-aware.** `--commit` auto-commits current worktree changes with a structured message tied to the checked task. Trace exactly which commit completed which task with `git log --grep`.

---

## Quick start

Install:

```bash
npm install -g @p10i/rundown@rc
```

Initialize templates in your repo:

```bash
rundown init
```

This creates your prompt templates:

```
.rundown/
  execute.md     # what the agent sees when doing the task
  verify.md      # how completion is checked
  repair.md      # what to try when verification fails
  plan.md        # how to expand a task into subtasks
```

Run against any Markdown file:

```bash
rundown run roadmap.md -- opencode run
```

Re-verify the most recently completed task (without changing checkbox state):

```bash
rundown reverify -- opencode run
```

Re-verify a specific historical run and fail fast without repair retries:

```bash
rundown reverify --run run-20260319T222645632Z-04e84d73 --no-repair -- opencode run
```

`rundown reverify` exits non-zero when verification fails, which makes it suitable for pre-release and pre-push confidence checks.

PowerShell-safe form:

```powershell
rundown run roadmap.md --worker opencode run
```

That's it. Write tasks. Run the command. Watch checkboxes earn their marks.

Common Git-aware forms:

```bash
rundown run roadmap.md --commit -- opencode run
rundown run roadmap.md --commit --commit-message "rundown: complete \"{{task}}\" in {{file}}" -- opencode run
rundown run roadmap.md --on-complete "git push" -- opencode run
```

---

## The loop

### Plan

Use `rundown plan` to expand a high-level task into concrete subtasks before execution begins. Big goals become small, runnable steps.

### Execute

The task context — the surrounding Markdown, the template, the file paths — gets rendered into a prompt and sent to your worker.

### Verify

A separate verification prompt checks the result. The task needs an explicit `OK` to pass. No silent failures.

Need a confidence check later (for example before release)? Use `rundown reverify` to re-run verify/repair for the latest completed task from artifacts, without advancing task selection.

### Repair

If verification fails, a repair prompt fires, the worker retries, and verification runs again. Completion is earned, not assumed.

---

## Why this matters

AI tools keep getting better. The bottleneck is no longer capability — it's **coordination**. Who told the agent what to do? Did it actually work? How do you pick up where it left off?

`rundown` answers all three with the most boring technology possible: a text file with checkboxes.

That's the point. The interface should be so simple you can reconstruct it from memory. Plain files. Visible prompts. Predictable selection. Auditable results.

If agents are going to be part of everyday software work, the control surface should be something you already know how to read, write, diff, and review.

You already know Markdown. Now Markdown knows how to finish.

---

## Docs

| | |
|---|---|
| [Overview](docs/overview.md) | Product model, task selection, modes, runtime behavior |
| [CLI](docs/cli.md) | Commands, flags, shell-friendly usage |
| [Templates](docs/templates.md) | Template files, variables, prompt rendering |
| [Examples](docs/examples.md) | Practical flows: planning, validation, inline CLI, `opencode` |

---

## Migration notes (programmatic API)

### Breaking: root exports are now intentionally narrow

The package root (`@p10i/rundown`) now exports only `createApp`.

If you previously imported low-level helpers from the root barrel (for example `parseTasks`, `runWorker`, `validate`, `correct`, `resolveSources`, runtime artifact helpers, or Git/hook helpers), those imports are no longer part of the supported root API.

Use `createApp()` as the stable programmatic entrypoint.

### Breaking: `createApp(...)` override shape changed

Dependency injection now uses a structured shape:

```ts
createApp({
  ports: { output: myOutputPort },
  useCaseFactories: { /* optional factory overrides */ },
})
```

Direct root-level use-case overrides such as `createApp({ runTask: ... })` are no longer supported. Use `useCaseFactories` for explicit, port-first wiring.

---

## Status

`rundown` is usable today and intentionally small.

It is not trying to become an orchestration platform. It is trying to make one workflow feel inevitable:

**Write the task. Let the system work. Check the box only when reality agrees.**

---

## Install

```bash
npm install -g @p10i/rundown@rc
rundown --help
```
