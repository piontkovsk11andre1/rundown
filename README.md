# `rundown`

> A future-prediction, test-driven framework.
> Use it to create art, run a business, do research, and write code.

---

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
execute -> validate -> repair -> validate -> repair -> ... -> resolve -> repair -> stop or reset
```

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
design/rev.0/Target.md             # Last released revision (`rd docs release`)
design/rev.1/Target.md
design/current/Target.md           # Current design document

migrations/1. Initialization.md    # First migration
migrations/2. Add Feature.md       # Adding a feature (changes relative to rev.0)
migrations/2.1 Snapshot.md         # Predicted state up to this point
migrations/2.2 Backlog.md          # Debt for continuing started migrations
migrations/2.3 Review.md           # Prediction vs. design comparison

specs/feature-tests.md
specs/end-to-end-tests.md
specs/ux-tests.md
```

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
# or
rd
```

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
- [Configuration](docs/configuration.md) — workers, profiles, and layered config
- [Templates](docs/templates.md) — repository-local Markdown templates
- [Examples](docs/examples.md) — end-to-end usage scenarios