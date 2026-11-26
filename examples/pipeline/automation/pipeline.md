# Resumable build pipeline

The program owns its checkpoint policy. The runtime supplies loading, cancellation,
diagnostics and IO; it does not infer whether an application job is complete.

## Dependencies

| Source     | Kind     | Binding | Description                                                     |
| ---------- | -------- | ------- | --------------------------------------------------------------- |
| ./plan.md  | markdown | plan    | Revision-checked row claims and completion.                     |
| ./build.md | markdown | build   | Work generation, subprocess execution and receipt verification. |

## Method: run

Process the first unfinished row until the plan is complete. A valid receipt is
verified even after interruption; completion is committed only after that check.

### Parameters

| Name       | Type   | Required | Default | Description                                                            |
| ---------- | ------ | -------- | ------- | ---------------------------------------------------------------------- |
| file       | string | yes      |         | Absolute plan path.                                                    |
| pauseAfter | string | yes      |         | Optional job ID at which to await cancellation after receipt creation. |
| context    | object | yes      |         | Invocation capabilities.                                               |

### Returns

| Type              | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `Promise<object>` | IDs completed in this invocation and build/reuse information. |

### Implementation

```js
const completed = [];
let current;
try {
  for (;;) {
    context.signal.throwIfAborted();
    current = await plan.claim(file, context);
    if (!current) return { completed };
    const work = await build.prepare(current, file, context);
    const result = await build.execute(work, context);
    if (current.id === pauseAfter) {
      context.log.info("Checkpoint ready", {
        checkpoint: true,
        id: current.id,
      });
      context.signal.throwIfAborted();
      await new Promise((_, reject) =>
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        ),
      );
    }
    await plan.complete(file, current.id, current.owner, context);
    completed.push({ id: current.id, built: result.built });
    current = undefined;
  }
} finally {
  if (current) {
    try {
      await plan.release(file, current.id, current.owner, context);
    } catch (error) {
      context.log.warn("Claim cleanup needs review", {
        id: current.id,
        message: error.message,
      });
    }
  }
}
```

### Notes

Claims identify the local process and invocation. This example coordinates local
CLI runners, not distributed hosts. A cooperative stop releases the claim and
records interrupted status. After a forced process exit, a dead owner can be
reclaimed. A live owner is never silently displaced. PID reuse can require manual
review; it is deliberately safer to stop than guess about ownership.
