# Report worker

Ordinary application code updates a view received explicitly from its caller.

## Dependencies

| Source               | Kind       | Binding | Description                      |
| -------------------- | ---------- | ------- | -------------------------------- |
| node:timers/promises | javascript | timers  | Cancellable demonstration delay. |

## Method: process

Update progress and explicitly close the view only after all work succeeds.
The caller tracks this operation so exceptions fail the invocation.

### Parameters

| Name    | Type   | Required | Default | Description                     |
| ------- | ------ | -------- | ------- | ------------------------------- |
| view    | object | yes      |         | The caller's live document.     |
| context | object | yes      |         | Active invocation capabilities. |

### Returns

| Type            | Description                                 |
| --------------- | ------------------------------------------- |
| `Promise<void>` | Resolves after explicitly closing the view. |

### Implementation

```js
for (let completed = 1; completed <= 3; completed++) {
  await timers.setTimeout(40, undefined, { signal: context.signal });
  context.log.info("Processed item", { completed });
  view.update({ completed });
}
view.update({ status: "Completed", findings: ["All items processed."] });
view.close();
```
