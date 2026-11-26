# Agent commands

## Command: agent

Ask an external harness to complete one task and report its outcome.

### Parameters

| Name   | Type   | Required | Default                                    | CLI | Description          |
| ------ | ------ | -------- | ------------------------------------------ | --- | -------------------- |
| prompt | string | no       | `"Report success for this demonstration."` | 1   | The task to execute. |

### Returns

| Type   | Description                      |
| ------ | -------------------------------- |
| object | The reported successful outcome. |

### Handler

```js
const harness = await rundown.loadModule("./harness.md");
return harness.run(args.prompt, context);
```
