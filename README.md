# `rundown`

> A test-driven planning and execution framework.
> Use it to create art, run a business, do research, and write code.

## Planning model

The plan of any work is a model of a future result. If the work is planned correctly, we can decompose it into deterministic steps, materialize those steps in the workspace, and verify the outcome with tests.

Imagine work shaped like this:

```text
A -> B -> C
```

### Planning

At a sufficient scale, AI can predict `A -> C` across all domains present in its training set. But if the *materialization* is complex — potentially millions of steps — we eventually hit a limit: an insufficiently precise step (too large a group) admits too many interpretations. The chance of successfully predicting lower-level steps drops.

And this is the level at which the plan is materialized — where we want to use AI, computers, controllers, robots. At this boundary between **plan** and **build**, predictability matters most: for automation and optimization. It is another level, `A1 -> C1`, which we only leave when the AI directly produces an `output` or triggers a `launch`. Here we care about:

- **Cost** — each step should be cheap.
- **Reusability** — steps should group into reusable tools.

When predicting *in depth*, we predict in chunks, searching for the optimal level of description at which sequential materialization and optimization remain effective.

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

Is something goes wrong:
```bash
rundown repair
```

`rndn` is a first-class executable alias for `rundown`; both names run the same CLI entrypoint with identical behavior.

…and more.

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

Run `rundown --help` for command and option reference.
