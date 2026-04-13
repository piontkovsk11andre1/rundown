# Progress Lifecycle Hook Map

This document maps current silence gaps and defines exact lifecycle hook points
for status emission across `run`, delegated `rundown:`, `plan`, `research`, and
`discuss` flows.

The goal is to make progress visible even when `--show-agent-output` is `false`,
without changing raw stdout/stderr forwarding semantics.

## Rules

- Lifecycle status uses structured output events (`info`, and optional future
  `progress`) and is always-on.
- Raw worker stdout/stderr remains gated by `showAgentOutput`.
- Heartbeat status lines are used for unbounded waits; bounded loops use attempt
  counters.
- Messages must be parse-safe and stable in non-TTY output.

## Silence Gap Map

### `run` command (`src/application/run-task-iteration.ts` + helpers)

- Visible now: `Next task: ...`, then often long silence until success/failure.
- Gap: prompt preparation and execution dispatch have no explicit phase updates.
- Gap: verify/repair lifecycle detail is minimal unless failure occurs.

### Delegated `rundown:` (`src/application/task-execution-dispatch.ts`)

- Visible now: one delegation line before spawning nested rundown.
- Gap: no in-progress signal while nested process runs.
- Gap: completion state is implicit unless non-zero failure bubbles up.

### `plan` (`src/application/plan-task.ts`)

- Visible now: planning start + per-scan label.
- Gap: each scan has no explicit "worker started" or "worker finished" status.
- Gap: convergence/no-op vs insertion outcomes are partially visible but not
  consistently framed as phase transitions.

### `research` (`src/application/research-task.ts`)

- Visible now: mostly terminal error/success lines.
- Gap: long prompt expansion and worker execution phases can be silent.
- Gap: post-run constraint checks (checkbox and TODO guardrails) are not
  announced as phases.

### `discuss` (`src/application/discuss-task.ts`)

- Visible now: `Next task: ...`, then potential long silence in TUI/wait flow.
- Gap: source resolution, lock acquisition, prompt build, and worker start are
  not clearly surfaced as lifecycle phases.

## Hook Points by Module

## `src/application/run-task-iteration.ts`

- Hook `run.task.selected`: after `Next task` emit, before worker resolution.
- Hook `run.prompt.preparing`: before `prepareTaskPrompts(...)`.
- Hook `run.prompt.ready`: after prompt prep success, before dry-run/dispatch
  branching.
- Hook `run.dispatch.start`: immediately before `dispatchTaskExecution(...)`.
- Hook `run.dispatch.result`: immediately after dispatch returns, keyed by
  `ready-for-completion` / `execution-failed` / `detached`.
- Hook `run.iteration.complete.start`: immediately before `completeTaskIteration(...)`.

## `src/application/task-execution-dispatch.ts`

- Hook `dispatch.verify-only.skip`: before returning verify-only shortcut.
- Hook `dispatch.inline-cli.start`: before `executeInlineCli(...)`.
- Hook `dispatch.inline-cli.finish`: after inline CLI returns (exit status).
- Hook `dispatch.rundown.start`: before `executeRundownTask(...)`; include
  subcommand and delegated args.
- Hook `dispatch.rundown.heartbeat.start`: start periodic "still running"
  ticker tied to delegated process lifecycle.
- Hook `dispatch.rundown.heartbeat.stop`: stop ticker on close/error.
- Hook `dispatch.rundown.finish`: after delegated result with exit code summary.
- Hook `dispatch.worker.start`: before `runWorker(...)`.
- Hook `dispatch.worker.finish`: after worker returns (wait/detached + exit).
- Hook `dispatch.memory.persist.start`: before memory write.
- Hook `dispatch.memory.persist.finish`: after memory write success/failure.

## `src/application/complete-task-iteration.ts`

- Hook `completion.verify.start`: immediately before entering verify loop.
- Hook `completion.verify.pass` / `completion.verify.fail`: after verify loop
  returns.
- Hook `completion.checkbox.check`: before `checkTaskUsingFileSystem(...)`.
- Hook `completion.hooks.start`: before `afterTaskComplete(...)`.
- Hook `completion.finish`: after `finishRun(...)` success.

## `src/application/verify-repair-loop.ts`

- Hook `verify.initial.start`: before first `taskVerification.verify(...)`.
- Hook `verify.initial.result`: after initial verify pass/fail.
- Hook `repair.loop.start`: once before entering loop with max attempts.
- Hook `repair.attempt.start`: per attempt (`attempt i of N`).
- Hook `repair.attempt.result`: per attempt pass/fail.
- Hook `repair.loop.finish`: after success or exhaustion.

## `src/application/plan-task.ts`

- Hook `plan.prompt.preparing`: before template rendering/CLI-block expansion.
- Hook `plan.prompt.ready`: after prompt expansion.
- Hook `plan.scan.start`: per scan before worker invocation.
- Hook `plan.scan.worker.start`: immediately before `runWorker(...)`.
- Hook `plan.scan.worker.finish`: immediately after worker return.
- Hook `plan.scan.apply.start`: before applying planner output.
- Hook `plan.scan.apply.finish`: after write/no-op/reject decision.
- Hook `plan.convergence`: when converged (no-change or no-additions), scan cap reached, or emergency cap reached.

## `src/application/research-task.ts`

- Hook `research.prompt.preparing`: before rendering and CLI-block expansion.
- Hook `research.prompt.ready`: after prompt expansion.
- Hook `research.worker.start`: before `runWorker(...)`.
- Hook `research.worker.finish`: after worker return.
- Hook `research.write.start`: before writing updated document.
- Hook `research.constraints.start`: before checkbox/TODO invariant checks.
- Hook `research.constraints.finish`: after invariants pass/fail.

## `src/application/discuss-task.ts`

- Hook `discuss.sources.resolved`: after source resolution and dedupe.
- Hook `discuss.task.selected`: after task selection.
- Hook `discuss.prompt.preparing`: before template render/CLI-block expansion.
- Hook `discuss.prompt.ready`: after expansion.
- Hook `discuss.session.start`: before `runWorker(...)`.
- Hook `discuss.session.finish`: after worker returns.
- Hook `discuss.checkbox-guard.start`: before mutation detection.
- Hook `discuss.checkbox-guard.finish`: after restore/no-restore decision.

## Delegation Context Tagging

Use a consistent context prefix so parent and child status lines remain clear:

- Parent delegation messages: `[delegate:rundown:<subcommand>] ...`
- Child run messages (nested process): `[nested:<command>] ...`

For non-nested tasks, omit prefix to avoid noise.

## Heartbeat Placement

Heartbeat is only needed around long, opaque waits:

- Delegated `rundown` subprocess execution.
- Potentially long worker `runWorker(...)` calls in `research` and `discuss`
  wait mode.

Do not emit heartbeat for short deterministic sections (prompt rendering,
validation, file writes).

## Next Implementation Order

1. Add delegated lifecycle + heartbeat in dispatch layer (highest impact).
2. Add execute/verify/repair phase boundaries in run/complete/verify loop.
3. Add minimal phase logs to `plan`, `research`, and `discuss`.
4. Add optional progress event and renderer behavior once baseline hooks are
   stable.
