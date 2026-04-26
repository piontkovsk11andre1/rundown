# Worker pattern

A worker pattern is the argv array used to spawn a worker. Two placeholders and one suffix mode control how the prompt is delivered.

Implemented in [src/domain/worker-pattern.ts](../../implementation/src/domain/worker-pattern.ts) (`parseWorkerPattern`) and consumed by [src/infrastructure/runner.ts](../../implementation/src/infrastructure/runner.ts).

## Placeholders

### `$file`

Replaced with the **absolute** path to the rendered prompt file (`prompt.md` inside the current phase artifact directory).

```json
["opencode", "run", "--file", "$file"]
```

### `$bootstrap`

Replaced with the path to the rendered prompt file as a **relative** path from the worker's `cwd`. Some agent CLIs accept a positional bootstrap file argument; this placeholder targets that convention.

```json
["opencode", "run", "$bootstrap", "--model", "opus-4.6"]
```

### Append-prompt fallback

If the pattern uses neither `$file` nor `$bootstrap`, the prompt-file path is **appended** as the last argument. This is the "just give me the prompt as the last positional argument" convention used by some harnesses.

```json
["claude"]   →   spawned as: claude /path/to/prompt.md
```

## Parsed pattern type

```ts
interface ParsedWorkerPattern {
  command: string[];      // tokenized argv (with placeholders unresolved)
  usesBootstrap: boolean;
  usesFile: boolean;
  appendFile: boolean;    // true when neither placeholder is present
}
```

## Prompt transport

Regardless of placeholder choice, the prompt **always travels via a file**, never via stdin. This is by design:

- workers can re-read the prompt at will (some do for retries),
- the artifact dir contains an exact replica of what the worker received,
- multi-line / large prompts are not subject to environment-variable or shell-quoting limits.

## Where prompts come from

1. The use case selects a template (see [../configuration/templates.md](../configuration/templates.md)).
2. Template variables are resolved against task context, frontmatter, vars file, and runtime metadata.
3. The rendered text is written to `<run-dir>/<seq>-<phase>/prompt.md`.
4. The pattern is expanded with placeholders pointing at that file.
5. `cross-spawn` invokes the worker with the expanded argv.

## Example resolutions

```json
// Pattern:
["opencode", "run", "--file", "$file", "$bootstrap"]

// Spawned argv:
["opencode", "run", "--file", "/abs/.rundown/runs/.../01-execute/prompt.md", "01-execute/prompt.md"]
```

```json
// Pattern (append mode):
["claude"]

// Spawned argv:
["claude", "/abs/.rundown/runs/.../01-execute/prompt.md"]
```
