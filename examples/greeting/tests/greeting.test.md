# Greeting tests

Test the compiled module and the real command boundary with Node assertions.

## Dependencies

| Source                | Kind       | Binding  | Description               |
| --------------------- | ---------- | -------- | ------------------------- |
| node:assert/strict    | javascript | assert   | Standard Node assertions. |
| @p10i/rundown/testing | javascript | testing  | Managed command runtime.  |
| ../example/module.md  | markdown   | greeting | The production module.    |

## Method: moduleGreeting

Verify the module's default and explicit argument behavior.

### Parameters

| Name | Type | Required | Default | Description |
| ---- | ---- | -------- | ------- | ----------- |

### Returns

| Type            | Description               |
| --------------- | ------------------------- |
| `Promise<void>` | Assertions pass or throw. |

### Implementation

```js
assert.equal(await greeting.greet(), "Hello, World!");
assert.equal(await greeting.greet("Ada"), "Hello, Ada!");
```

## Method: commandGreeting

Exercise catalog loading, command validation and invocation cleanup.

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
const runtime = await testing.createTestRuntime(t, { cwd: context.workdir });
assert.equal(await runtime.invoke("example", { name: "Ada" }), "Hello, Ada!");
await assert.rejects(runtime.invoke("example", { name: 42 }), {
  code: "RUNDOWN_ARGUMENTS",
});
```
