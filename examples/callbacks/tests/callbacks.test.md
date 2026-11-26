# Callback execution tests

Exercise the project's deterministic binding and callback scoping without a live provider.

## Dependencies

| Source             | Kind       | Binding | Description                   |
| ------------------ | ---------- | ------- | ----------------------------- |
| node:assert/strict | javascript | assert  | Standard Node assertions.     |
| ../harness.md      | markdown   | harness | Production callback workflow. |

## Method: callbackRoundTrip

The real fake binding calls completion and reporting tools over MCP.

### Parameters

| Name    | Type   | Required | Default | Description                           |
| ------- | ------ | -------- | ------- | ------------------------------------- |
| t       | object | yes      |         | Node's test context.                  |
| context | object | yes      |         | Rundown's managed invocation context. |

### Returns

| Type            | Description               |
| --------------- | ------------------------- |
| `Promise<void>` | Assertions pass or throw. |

### Implementation

```js
const result = await harness.run("Report completion", context);
assert.deepEqual(result, {
  ok: true,
  summary: "Deterministic callback round trip completed.",
});
```

## Method: scopedLifetime

A registration is closed before the scoped operation returns to its caller.

### Parameters

| Name    | Type   | Required | Default | Description                           |
| ------- | ------ | -------- | ------- | ------------------------------------- |
| t       | object | yes      |         | Node's test context.                  |
| context | object | yes      |         | Rundown's managed invocation context. |

### Returns

| Type            | Description               |
| --------------- | ------------------------- |
| `Promise<void>` | Assertions pass or throw. |

### Implementation

```js
let registration;
const result = await context.callbacks.with({}, async (current) => {
  registration = current;
  return "finished";
});
assert.equal(result, "finished");
assert.equal(registration.state, "closed");
await assert.rejects(registration.expose(), {
  code: "RUNDOWN_CALLBACK_CLOSED",
});
```
