# Work generation and verification

Generate work and receipts with do-md, run a bounded script, and verify existing
outputs before reusing them. This operation is deterministic and idempotent;
arbitrary deployment effects would need their own reconciliation policy.

## Dependencies

| Source                      | Kind       | Binding      | Description                              |
| --------------------------- | ---------- | ------------ | ---------------------------------------- |
| @p10i/do-md                 | javascript | doMd         | Read and generate application documents. |
| @p10i/rundown/process       | javascript | processTools | Bounded script execution.                |
| @p10i/rundown/observability | javascript | tracing      | External trace carrier.                  |
| node:fs/promises            | javascript | fs           | Output directories.                      |
| node:path                   | javascript | path         | Work paths.                              |
| node:url                    | javascript | url          | Application templates.                   |
| node:crypto                 | javascript | crypto       | Receipt digest.                          |
| node:process                | javascript | nodeProcess  | Native Node executable.                  |

## Method: prepare

Create an immutable work document for the claimed inputs. Reuse requires exact
content equality; changed user documents are not overwritten.

### Parameters

| Name    | Type   | Required | Default | Description              |
| ------- | ------ | -------- | ------- | ------------------------ |
| item    | object | yes      |         | Claimed ID and input.    |
| file    | string | yes      |         | Parent plan path.        |
| context | object | yes      |         | Invocation capabilities. |

### Returns

| Type              | Description         |
| ----------------- | ------------------- |
| `Promise<string>` | Work document path. |

### Implementation

```js
const folder = path.join(path.dirname(file), "work", item.id);
await fs.mkdir(folder, { recursive: true });
const work = path.join(folder, "Work.md");
const text = await render(
  "work",
  [
    ["ID", item.id],
    ["Input", item.input],
  ],
  context,
);
await ensure(work, text, context);
return work;
```

## Method: execute

Build or reconcile one work document. The receipt is published after artifact
verification, and the orchestrator marks the parent row complete afterward.

### Parameters

| Name    | Type   | Required | Default | Description              |
| ------- | ------ | -------- | ------- | ------------------------ |
| work    | string | yes      |         | Work document path.      |
| context | object | yes      |         | Invocation capabilities. |

### Returns

| Type              | Description                                        |
| ----------------- | -------------------------------------------------- |
| `Promise<object>` | Artifact/receipt paths and whether the script ran. |

### Implementation

```js
const parsed = await doMd.exportDoc({
  io: context.io,
  file: work,
  template: template("work"),
});
if (!parsed.ok) throw new doMd.DoMdError(parsed.errors[0]);
const data = Object.fromEntries(parsed.context.spec.rows);
const expected = await render(
  "artifact",
  [
    ["ID", data.ID],
    ["Result", data.Input.toUpperCase()],
  ],
  context,
);
const artifact = path.join(path.dirname(work), "Artifact.md");
let built = false;
let existing;
try {
  existing = await context.io.readFileAsync(artifact);
} catch (error) {
  if (!(await missing(artifact))) throw error;
}
if (existing !== undefined && existing !== expected)
  throw new Error(`Artifact changed; review ${artifact}`);
if (existing === undefined) {
  const script =
    'const fs=require("node:fs"),crypto=require("node:crypto");const [file,text]=process.argv.slice(1);const tmp=file+".tmp-"+crypto.randomUUID();fs.writeFileSync(tmp,text,{flag:"wx"});try{fs.linkSync(tmp,file);}finally{fs.unlinkSync(tmp);}';
  await context.observability.span("pipeline.script", { job: data.ID }, () =>
    processTools.runProcess(
      nodeProcess.execPath,
      ["-e", script, artifact, expected],
      {
        cwd: context.workdir,
        signal: context.signal,
        traceContext: tracing.traceCarrier(),
      },
    ),
  );
  built = true;
}
const actual = await context.io.readFileAsync(artifact);
if (actual !== expected)
  throw new Error(`Artifact verification failed: ${artifact}`);
const digest = crypto.createHash("sha256").update(actual).digest("hex");
const receipt = path.join(path.dirname(work), "Receipt.md");
await ensure(
  receipt,
  await render(
    "receipt",
    [
      ["ID", data.ID],
      ["SHA256", digest],
    ],
    context,
  ),
  context,
);
return { artifact, receipt, built };
```

## Method: template

Resolve adjacent application templates independently of invocation cwd.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |
| Execution  | sync    |

### Parameters

| Name | Type   | Required | Default | Description          |
| ---- | ------ | -------- | ------- | -------------------- |
| name | string | yes      |         | Known template name. |

### Returns

| Type   | Description             |
| ------ | ----------------------- |
| string | Absolute template path. |

### Implementation

```js
return url.fileURLToPath(new URL(`./${name}.md.template`, import.meta.url));
```

## Method: render

Generate application Markdown through do-md's normal Writer direction.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |

### Parameters

| Name    | Type                   | Required | Default | Description              |
| ------- | ---------------------- | -------- | ------- | ------------------------ |
| name    | string                 | yes      |         | Template name.           |
| rows    | `Array<Array<string>>` | yes      |         | Application values.      |
| context | object                 | yes      |         | Invocation capabilities. |

### Returns

| Type              | Description         |
| ----------------- | ------------------- |
| `Promise<string>` | Generated Markdown. |

### Implementation

```js
const data = { spec: { headers: ["Field", "Value"], rows } };
const writer = new doMd.Writer(data);
doMd.Template.compile(await context.io.readFileAsync(template(name))).execute(
  writer,
  writer.context,
  data,
);
return writer.toMarkdown();
```

## Method: ensure

Atomically create a document or verify that an existing one matches. This never
replaces a differing user artifact and never repeats an external operation.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |

### Parameters

| Name    | Type   | Required | Default | Description           |
| ------- | ------ | -------- | ------- | --------------------- |
| file    | string | yes      |         | Output path.          |
| text    | string | yes      |         | Expected content.     |
| context | object | yes      |         | Filesystem-backed IO. |

### Returns

| Type            | Description                              |
| --------------- | ---------------------------------------- |
| `Promise<void>` | Resolves after creation or verification. |

### Implementation

```js
try {
  await context.io.writeFileAtomicAsync(file, text, { ifAbsent: true });
} catch (error) {
  if ((await context.io.readFileAsync(file)) !== text) throw error;
}
```

## Method: missing

Distinguish an absent file from another read failure.

### Options

| Option     | Value   |
| ---------- | ------- |
| Visibility | private |

### Parameters

| Name | Type   | Required | Default | Description      |
| ---- | ------ | -------- | ------- | ---------------- |
| file | string | yes      |         | Filesystem path. |

### Returns

| Type               | Description                   |
| ------------------ | ----------------------------- |
| `Promise<boolean>` | True only for a missing file. |

### Implementation

```js
try {
  await fs.stat(file);
  return false;
} catch (error) {
  return error.code === "ENOENT";
}
```
