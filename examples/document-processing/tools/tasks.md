# Checklist summary

Read application Markdown using a do-md template. The checklist format is separate
from this module's documentation format.

## Dependencies

| Source      | Kind       | Binding | Description                                |
| ----------- | ---------- | ------- | ------------------------------------------ |
| @p10i/do-md | javascript | doMd    | Read structured data from Markdown.        |
| node:url    | javascript | url     | Resolve the adjacent application template. |

## Method: pending

Return counts for one flat checkbox list. Input validation and document diagnostics
come from do-md; no separate task-state file is created.

### Parameters

| Name    | Type   | Required | Default | Description                                   |
| ------- | ------ | -------- | ------- | --------------------------------------------- |
| file    | string | yes      |         | Absolute path to the checklist.               |
| context | object | yes      |         | Invocation context containing the IO adapter. |

### Returns

| Type              | Description                               |
| ----------------- | ----------------------------------------- |
| `Promise<object>` | Total, completed and pending item counts. |

### Implementation

```js
const template = url.fileURLToPath(
  new URL("./tasks.md.template", import.meta.url),
);
const result = await doMd.exportDoc({ io: context.io, file, template });
if (!result.ok) throw new doMd.DoMdError(result.errors[0]);
const items = result.context.tasks.items;
const completed = items.filter((item) => item.checked).length;
return { total: items.length, completed, pending: items.length - completed };
```
