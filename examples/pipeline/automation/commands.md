# Build pipeline

## Command: build

Generate work documents, build Markdown artifacts through a bounded subprocess,
verify receipts and persist completion in the plan. Repeated invocations skip
completed rows and reconcile interrupted work before marking it complete.

### Parameters

| Name       | Type   | Required | Default     | CLI           | Description                                                            |
| ---------- | ------ | -------- | ----------- | ------------- | ---------------------------------------------------------------------- |
| plan       | path   | no       | `"Plan.md"` | 1             | The build plan.                                                        |
| pauseAfter | string | no       | `""`        | --pause-after | Pause after a receipt, before completion, to demonstrate interruption. |

### Returns

| Type   | Description                                                               |
| ------ | ------------------------------------------------------------------------- |
| object | Completed job IDs and whether their artifacts were newly built or reused. |

### Handler

```js
const pipeline = await rundown.loadModule("./pipeline.md");
return pipeline.run(args.plan, args.pauseAfter, context);
```
