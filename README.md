# `rundown`

> A future-prediction, test-driven framework.
> Use it to create art, run a business, do research, and write code.

## Prediction

The plan of any work is a prediction of the future. If the work is planned correctly, then for distant predictions it doesn't need to be executed — it's enough to ask the AI to imagine that the plan has already been carried out and to plan further from there.

Imagine work shaped like this:

```text
A -> B -> C
```

From this shape we can isolate two tasks that best model the real situations in which predictions are useful.

### Planning

In **task #1** we know `A` and `C`, but `B` is unknown.

At a sufficient scale, AI can predict `A -> C` across all domains present in its training set. But if the *materialization* is complex — potentially millions of steps — we eventually hit a limit: an insufficiently precise step (too large a group) admits too many interpretations. The chance of successfully predicting lower-level steps drops.

And this is the level at which the plan is materialized — where we want to use AI, computers, controllers, robots. At this boundary between **plan** and **build**, predictability matters most: for automation and optimization. It is another level, `A1 -> C1`, which we only leave when the AI directly produces an `output` or triggers a `launch`. Here we care about:

- **Cost** — each step should be cheap.
- **Reusability** — steps should group into reusable tools.

When predicting *in depth*, we predict in chunks, searching for the optimal level of description at which sequential materialization and optimization remain effective.

But what if we ask *"what is C?"*, knowing `A`, `A -> B` and `B -> C`? In **task #2** we ask the AI to imagine the state that results from the sum of the predicted steps — provided this is cheaper than *materializing* it (doing the work in the real world and measuring the result). AI handles this quite effectively, which lets us plan further toward `C` with reasonable clarity.

The problem arises when we need to *guarantee* that `C` is reachable by following the plan. To guarantee this, we need a protocol that verifies correspondence between the prediction and something that actually happened in the real world.

### Execution

When materializing a prediction, at some point we touch reality. This moment of contact matters: it is where the prediction transitions into the level at which materialization directly occurs. This moment is, in effect, the **agent** between prediction and the real world.

Each touch splits the prediction into *before* and *after*. We want to:

- **Control** the process.
- **Analyze** what happened.
- **Collect metrics** to confirm that the AI is still right and that materialization remains accurate.

But each action is also part of a session — a group we want to observe on its own. For all of this we need **non-probabilistic, deterministic automation** that guarantees each interaction with the real world happened in the correct order, at the correct time, and that the materialized result matches the prediction.

This is what `rundown` is for.

---


### The workload protocol

> See [docs/overview.md](docs/overview.md) for the full core-model reference.

At the **lowest level**, `rundown` defines a workload protocol:

```markdown
Context body.

- [x] Finished task
- [ ] Unfinished task
- [ ] Another unfinished task
```

An empty checkbox is interpreted as an **instruction**.

Each instruction is wrapped in a loop, with configurable retries, so imperfect execution predictions can be worked through:

```text
execute -> verify -> repair -> verify -> repair -> ... -> resolve -> repair -> stop or reset
```

You can switch models on `verify -> repair` layer, using strongest on the last `repair` or `resolve`.

### Extensible tooling

`rundown` supports a flexible, extensible tool set:

```markdown
---
rundown:
  profiles:
    local-model: "opencode run $bootstrap --model localhost/gpt"
---
Context body.

- profile=thinking
  - [x] Finished task
  - [ ] profile=local-model: Unfinished task
  - [ ] cli: deploy now
  - [ ] for: Each modified file
    - [ ] quick: Do this
    - [ ] quick: Do that
    - [ ] verify: Tests run ok
```

### Single-file or multi-file

A single Markdown file can seed an entire project:

```markdown
# Roadmap

For each task in this file create a numbered migration file
in current dir with seed produced from the task item.
Then run explore on the file.

- [ ] Add this feature
- [ ] Add that feature
- [ ] Extend something
```

```bash
rundown all roadmap.md
```

This executes the TODO items, producing research and plan output — each with its own TODO items you can then execute:

```bash
rundown all .
```

…and more.

> See [docs/configuration.md](docs/configuration.md) for profiles, workers, and per-command overrides.
> See [docs/templates.md](docs/templates.md) for the template system.

### Recommended project structure

At the **highest level**, `rundown` recommends the following layout (names can be changed).

You don't have to use this if you don't want to.

```text
design/
migrations/
specs/
```

A concrete example:

```text
design/rev.0/Target.md             # Last released revision (`rundown design release`)
design/rev.1/Target.md
design/current/Target.md           # Current design document

migrations/0001-initialize.md      # First migration
migrations/0002-add-feature.md     # Adding a feature (changes relative to rev.0)
migrations/0002--snapshot.md       # Predicted state up to this point
migrations/0002--backlog.md        # Debt for continuing started migrations
migrations/0002--review.md         # Prediction vs. design comparison

specs/feature-tests.md
specs/end-to-end-tests.md
specs/ux-tests.md
```

Revision contract for `design diff` and migration context:

- `rev.0` is the explicit initial baseline revision.
- The first discovered revision in a repository compares from nothing, even when that first revision is `rev.1`.
- For any target revision with no discovered lower predecessor, diff semantics are `nothing -> target`.

These files don't have to live in the same directory where you work on the materialization result — which keeps working folders clean. You choose which modules live where: keep the design or the specs in your working directory, and split the rest across separate `rundown` directories.

### What it does

You can work on a document and predict migrations, or create migrations that drift the target. `rundown` will:

- Predict the materialized target from the migrations.
- Propose the next migrations.
- Run automated tests based on the prediction — how many features are already predicted, whether scenarios work, whether the document conforms to the format, and any other **quality gate** you define.

### As a harness

You can use `rundown` as a harness:

```bash
# Depending on your harness:
rundown with opencode
rundown with claude
rundown with pi

# Next time in the same dir:
rundown
# or the supported executable alias:
rd
```

`rd` is a first-class executable alias for `rundown`; both names run the same CLI entrypoint with identical behavior.

Ask the agent to set everything up and start working — it will answer all your questions.

> See [docs/cli.md](docs/cli.md) for all commands and options.

---

## Installation

```bash
# npm
npm i -g @p10i/rundown

# yarn
yarn global add @p10i/rundown

# pnpm
pnpm add -g @p10i/rundown

# bun
bun add -g @p10i/rundown
```

## Documentation

- [Overview](docs/overview.md) — core model, workflow, and task lifecycle
- [CLI](docs/cli.md) — commands, flags, and global options
- [CLI: `--agents`](docs/cli-agents.md) — print deterministic AGENTS guidance from root mode
- [CLI: root `rundown`](docs/cli-root.md) — no-argument interactive help startup behavior
- [CLI: `config`](docs/cli-config.md) — inspect merged configuration and value sources
- [CLI: `init`](docs/cli-init.md) — scaffold a new rundown workspace
- [CLI: `call`](docs/cli-call.md) — run provider/model calls with CLI-managed context
- [CLI: `do`](docs/cli-do.md) — execute unchecked tasks in a markdown task document
- [CLI: `all`](docs/cli-all.md) — execute all tasks across a file or directory
- [CLI: `discuss`](docs/cli-discuss.md) — collaborate on plans and next actions from task files
- [CLI: `design`](docs/cli-design.md) — manage design revisions and release snapshots
- [CLI: `explore`](docs/cli-explore.md) — generate codebase research and findings artifacts
- [CLI: `list`](docs/cli-list.md) — list tasks, runs, and actionable work items
- [CLI: `next`](docs/cli-next.md) — surface the next executable task in a workflow
- [CLI: `make`](docs/cli-make.md) — create migration/design/spec documents from templates
- [CLI: `migrate`](docs/cli-migrate.md) — create and manage migration documents
- [CLI: `materialize`](docs/cli-materialize.md) — materialize predicted state into workspace files
- [CLI: `plan`](docs/cli-plan.md) — produce implementation plans from prompts and context
- [CLI: `research`](docs/cli-research.md) — gather structured research artifacts for tasks
- [CLI: `run`](docs/cli-run.md) — execute full rundown phases with verification and repair loops
- [CLI: `start`](docs/cli-start.md) — bootstrap and launch a guided rundown session
- [CLI: `test`](docs/cli-test.md) — run verification/test workflows against predicted or real state
- [CLI: `reverify`](docs/cli-reverify.md) — re-run verification on prior runs and artifacts
- [CLI: `revert`](docs/cli-revert.md) — revert selected rundown-generated changes safely
- [CLI: `undo`](docs/cli-undo.md) — undo recent rundown operations and restore prior state
- [CLI: `unlock`](docs/cli-unlock.md) — clear stale run locks and recover blocked workspaces
- [CLI: `loop`](docs/cli-loop.md) — run iterative execution loops over task documents
- [CLI: `with`](docs/cli-with.md) — configure and run a harness-backed agent session
- [CLI: `query`](docs/cli-query.md) — investigate codebase questions with orchestrated workflows
- [CLI: `worker-health`](docs/cli-worker-health.md) — check worker process status and diagnostics
- [CLI: `memory-view`](docs/cli-memory-view.md) — inspect source-local memory artifacts and summaries
- [CLI: `memory-validate`](docs/cli-memory-validate.md) — validate memory artifacts and optionally fix issues
- [CLI: `memory-clean`](docs/cli-memory-clean.md) — remove orphaned/outdated memory artifacts
- [CLI: `workspace`](docs/cli-workspace.md) — manage workspace link metadata and cleanup
- [CLI: `artifacts`](docs/cli-artifacts.md) — inspect and clean saved run artifacts
- [CLI: `log`](docs/cli-log.md) — tail and filter global execution logs
- [Configuration](docs/configuration.md) — workers, profiles, and layered config
- [Templates](docs/templates.md) — repository-local Markdown templates
- [API](docs/api.md) — programmatic API reference
- [Examples](docs/examples.md) — end-to-end usage scenarios
