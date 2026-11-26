# Checklist commands

## Command: pending

Count completed and pending items in a flat Markdown checklist without changing it.

### Parameters

| Name   | Type | Required | Default | CLI | Description                     |
| ------ | ---- | -------- | ------- | --- | ------------------------------- |
| target | path | yes      |         | 1   | The Markdown checklist to read. |

### Returns

| Type   | Description                               |
| ------ | ----------------------------------------- |
| object | Total, completed and pending item counts. |

### Handler

```js
const tasks = await rundown.loadModule("./tasks.md");
return tasks.pending(args.target, context);
```
