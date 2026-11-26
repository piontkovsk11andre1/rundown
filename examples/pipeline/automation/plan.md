# Build plan access

Read the latest plan for each transition. Stable row IDs and revision checks
prevent stale row indexes or another runner's successful claim from being overwritten.

## Dependencies

| Source       | Kind       | Binding     | Description                            |
| ------------ | ---------- | ----------- | -------------------------------------- |
| @p10i/do-md  | javascript | doMd        | Editor and template-bound table cells. |
| node:url     | javascript | url         | Adjacent application template path.    |
| node:process | javascript | nodeProcess | Local owner-process identity.          |

## Method: claim

Claim the first unfinished row. An existing live owner blocks a second runner;
an interrupted or dead-owner row is reconciled by the build stage.

### Parameters

| Name    | Type   | Required | Default | Description              |
| ------- | ------ | -------- | ------- | ------------------------ |
| file    | string | yes      |         | Plan path.               |
| context | object | yes      |         | Invocation capabilities. |

### Returns

| Type               | Description                                     |
| ------------------ | ----------------------------------------------- |
| `Promise<?object>` | The claimed ID, input and owner token, or null. |

### Implementation

```js
const editor = await open(file, context);
const rows = editor.context.jobs.rows;
const index = rows.findIndex((row) => row[2] !== "done");
if (index < 0) return null;
const [id, input, , , prior] = rows[index];
if (prior && alive(Number(prior.split(":")[0])))
  throw new Error(`Job ${id} has a live owner`);
const owner = `${nodeProcess.pid}:${context.id}`;
editor.set(`jobs.rows[${index}][2]`, "running");
editor.set(`jobs.rows[${index}][4]`, owner);
await editor.save();
return { id, input, owner };
```

## Method: complete

Commit status, checkbox and cleared ownership in one revision-checked save.

### Parameters

| Name    | Type   | Required | Default | Description                        |
| ------- | ------ | -------- | ------- | ---------------------------------- |
| file    | string | yes      |         | Plan path.                         |
| id      | string | yes      |         | Stable job ID.                     |
| owner   | string | yes      |         | Claim token that must still match. |
| context | object | yes      |         | Invocation capabilities.           |

### Returns

| Type            | Description                          |
| --------------- | ------------------------------------ |
| `Promise<void>` | Resolves after committed completion. |

### Implementation

```js
const editor = await open(file, context);
const index = editor.context.jobs.rows.findIndex((row) => row[0] === id);
if (index < 0 || editor.context.jobs.rows[index][4] !== owner)
  throw new Error(`Claim changed for ${id}`);
editor.set(`jobs.rows[${index}][2]`, "done");
editor.set(`jobs.rows[${index}][3]`, "[x]");
editor.set(`jobs.rows[${index}][4]`, "");
await editor.save();
```

## Method: release

Release only this invocation's unfinished claim. This is metadata cleanup, not a
rollback of generated documents or completed subprocess effects.

### Parameters

| Name    | Type   | Required | Default | Description              |
| ------- | ------ | -------- | ------- | ------------------------ |
| file    | string | yes      |         | Plan path.               |
| id      | string | yes      |         | Stable job ID.           |
| owner   | string | yes      |         | Expected owner.          |
| context | object | yes      |         | Invocation capabilities. |

### Returns

| Type            | Description                                             |
| --------------- | ------------------------------------------------------- |
| `Promise<void>` | Resolves after cleanup or if ownership already changed. |

### Implementation

```js
const editor = await open(file, context);
const index = editor.context.jobs.rows.findIndex((row) => row[0] === id);
if (index < 0 || editor.context.jobs.rows[index][4] !== owner) return;
editor.set(`jobs.rows[${index}][2]`, "interrupted");
editor.set(`jobs.rows[${index}][4]`, "");
await editor.save();
```

## Method: open

Open current source and its precise cell bindings; callers never retain an editor
across an external operation.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |

### Parameters

| Name    | Type   | Required | Default | Description              |
| ------- | ------ | -------- | ------- | ------------------------ |
| file    | string | yes      |         | Plan path.               |
| context | object | yes      |         | Invocation capabilities. |

### Returns

| Type              | Description     |
| ----------------- | --------------- |
| `Promise<object>` | A do-md Editor. |

### Implementation

```js
return doMd.Editor.open({
  io: context.io,
  file,
  template: url.fileURLToPath(new URL("./plan.md.template", import.meta.url)),
});
```

## Method: alive

Treat permission errors as potentially live ownership rather than taking over.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |
| Execution  | sync    |

### Parameters

| Name | Type   | Required | Default | Description                |
| ---- | ------ | -------- | ------- | -------------------------- |
| pid  | number | yes      |         | Recorded local process ID. |

### Returns

| Type    | Description                             |
| ------- | --------------------------------------- |
| boolean | Whether the owner may still be running. |

### Implementation

```js
try {
  nodeProcess.kill(pid, 0);
  return true;
} catch (error) {
  return error.code !== "ESRCH";
}
```
