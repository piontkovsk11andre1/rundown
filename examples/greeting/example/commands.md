# Greeting commands

## Command: example

Greet a person by name, or greet the world when no name is supplied.

### Parameters

| Name | Type   | Required | Default   | CLI | Description          |
| ---- | ------ | -------- | --------- | --- | -------------------- |
| name | string | no       | `"World"` | 1   | The person to greet. |

### Returns

| Type   | Description   |
| ------ | ------------- |
| string | The greeting. |

### Handler

```js
const greeting = await rundown.loadModule("./module.md");
return greeting.greet(args.name);
```
