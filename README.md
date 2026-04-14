`rundown`

Future prediction test-driven framework.
With it you can create art, run a business, do research, and write code.

## Prediction

The plan of any work is a prediction of the future. If work is planned correctly, then for distant predictions it doesn't need to be executed — it's enough to ask the AI to imagine that the plan has already been carried out and to plan further based on that.

Imagine work like this:
```
A -> B -> C
```

We can isolate two tasks that best model real situations where predictions are useful to us.

### Planning

In task #1 we know `A` and `C`, but `B` is unknown. At a certain scale, AI will be able to predict `A -> C` across all domains from the training set. But if the complexity of `materialization` is high — there may be many steps, millions of them. There is a limit at which we hit the point where an insufficiently precisely described step (too large a group) can be understood in too many ways. In other words — the chance of successfully predicting lower-level steps drops.

And this is the level at which materialization of the plan happens, where we want to use AI, computers, controllers, robots. At this boundary between planning and direct work (plan / build), predictability matters most: for automation and optimization. This is another level `A1 -> C1` at which we exit prediction only when the AI directly performs `output` or `launch`. At this level we care about cheapness and the ability to group steps into reusable tools.

When predicting "in depth" we predict in chunks, trying to find the optimal level of step description at which sequential materialization and optimization will be effective.

But what if we ask "what is Z?", knowing `A` and the steps? In task #2 we ask the AI to imagine a state that resulted from the sum of the predicted steps, if this is cheaper than `materializing` it (doing the work in the real world and looking at the result, taking a measurement). AI can handle this quite effectively too, which lets us plan further toward `C` fairly clearly.

The problem arises when it comes to guaranteeing that we can reach `C` if we follow the plan. To guarantee this, we need a protocol that allows us to verify correspondence between the prediction and something that actually happened in the real world.

### Execution

When materializing a prediction in reality, at some point we touch the real world. This moment of contact is very important, because at it the prediction transitions to the level where materialization directly happens. This moment is essentially the "agent" between the prediction and the real world.

With each touch to the real world, the prediction splits into "before" and "after". We want to control this process, analyze it, collect metrics for analysis, to confirm that the AI is 100% right and we are still materializing the prediction accurately enough. But each action individually is part of a session, a group, which we want to observe separately. For all of this we need non-probabilistic deterministic automation that guarantees each interaction with the real world happened in the right order and at the right time, and that the materialized result matches the predicted one.

### Rundown

This is what rundown exists for.

At the lowest level it defines the workload protocol:
```
Context body.

- [x] Finished task
- [ ] Unfinished task
- [ ] Another unfinished task
```

In which an empty checkbox is interpreted as an instruction.

This instruction will be wrapped in a loop, in which we can control retries, which lets us work through imperfect execution predictions:
```
execute -> validate -> repair -> validate -> repair -> ... -> resolve -> repair -> stop or reset
```

It supports a flexible set of tools that you can extend:

```
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

And much more.

At the highest level, rundown recommends this structure (it can be renamed):

```
design
migrations
specs
```

For example, with a set of files like this:
```
design/rev.0/Target.md               <- Last released revision (`rd docs release`)
design/rev.1/Target.md
design/current/Target.md             <- Current design document
migrations/1. Initialization.md      <- First migration
migrations/2. Add Feature.md         <- Adding a feature (changes relative to rev.0)
migrations/2.1 Snapshot.md           <- Predicted state up to this point
migrations/2.2 Backlog.md            <- Debt for continuing started migrations
migrations/2.3 Review.md             <- Comparison of prediction against design
specs/feature-tests.md
specs/end-to-end-tests.md
specs/ux-tests.md
```

These files don't have to live in the same directory where you work on the materialization result — which keeps folders clean.
You choose which modules to declare where. You can keep the design or the specs in your own directory, and split the other components across separate `rundown` working directories.

You can work on a document and predict migrations, or create migrations that drift the target. `rundown` will predict the materialized target from the migrations and propose the next migrations. You can run automated tests based on the prediction, which will show how many features have already been predicted, whether scenarios work, whether the document conforms to the format, and much more. Any quality gate.

You can use `rundown` as a harness:

```bash
# Depending on your harness:
rundown with opencode
rundown with claude
rundown with pi
```

And ask the agent to set everything up and start working. It will answer all your questions.

Installation:

```bash
npm i -g @p10i/rundown
```