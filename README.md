# `rundown`

> A test-driven future-prediction framework.
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