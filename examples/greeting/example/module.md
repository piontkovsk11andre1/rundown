# Greeting

Produce a friendly greeting for a person.

## Constants

| Name       | Value     | Description                       |
| ---------- | --------- | --------------------------------- |
| salutation | `"Hello"` | The opening word of the greeting. |

## Method: greet

Return a greeting. Names retain their supplied spacing and capitalization.

### Parameters

| Name | Type   | Required | Default   | Description          |
| ---- | ------ | -------- | --------- | -------------------- |
| name | string | no       | `"World"` | The person to greet. |

### Returns

| Type              | Description   |
| ----------------- | ------------- |
| `Promise<string>` | The greeting. |

### Implementation

```js
return format(name);
```

### Examples

```js
await greeting.greet("Ada"); // "Hello, Ada!"
```

## Method: format

Assemble the greeting without external effects.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |
| Execution  | sync    |

### Parameters

| Name | Type   | Required | Default | Description          |
| ---- | ------ | -------- | ------- | -------------------- |
| name | string | yes      |         | The person to greet. |

### Returns

| Type   | Description             |
| ------ | ----------------------- |
| string | The formatted greeting. |

### Implementation

```js
return `${salutation}, ${name}!`;
```
