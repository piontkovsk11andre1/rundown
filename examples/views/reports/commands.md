# Live report commands

Run a small program that returns an explicitly closed, live Markdown presentation.

## Command: report

Process three demonstration items and update a shared view from a module.

### Parameters

| Name | Type | Required | Default | CLI | Description |
| ---- | ---- | -------- | ------- | --- | ----------- |

### Returns

| Type   | Description                                        |
| ------ | -------------------------------------------------- |
| object | A live view; JSON output receives its final state. |

### Handler

```js
const worker = await rundown.loadModule("./worker.md");
const view = await rundown.createView("./report.md.template", {
  status: "Processing",
  completed: 0,
  total: 3,
  findings: [],
});
view.track(() => worker.process(view, context));
return view;
```
