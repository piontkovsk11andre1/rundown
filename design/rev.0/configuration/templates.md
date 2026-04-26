# Templates

Prompt templates render tasks into worker-bound prompts. Loaded by [src/infrastructure/adapters/fs-template-loader.ts](../../implementation/src/infrastructure/adapters/fs-template-loader.ts) (port: `TemplateLoader`); built-in fallbacks in [src/domain/defaults.ts](../../implementation/src/domain/defaults.ts).

## Template categories

| Template | Purpose | Used by |
|---|---|---|
| `run` | Default execute-and-verify prompt | `run`, `materialize`, `call`, `do`, `loop`, `all` |
| `verify` | Verification phase prompt | verify-only intent and verify phases |
| `repair` | Repair phase prompt | repair iterations |
| `resolve` | Terminal repair phase prompt | `resolve` routing |
| `plan` | Plan-task prompt | `plan` |
| `deep-plan` | Child-TODO planner prompt | `plan --deep` |
| `discuss` | Discussion bootstrap | `discuss` |
| `research` | Research-mode prompt | `research`, optional pre-pass for `query` |
| `memory` | Memory-capture prompt | `memory:` and aliases |
| `migrate` | Migration planner prompt | `migrate` convergence loop |

## Template lookup

For a given category `c`:

1. `<config-dir>/templates/<c>.md` if present.
2. `<config-dir>/templates/<c>/<variant>.md` for variant selection.
3. Built-in default from [src/domain/defaults.ts](../../implementation/src/domain/defaults.ts).

Templates are plain Markdown with `${var}` placeholders.

## Built-in variables

Resolved by [src/domain/template-vars.ts](../../implementation/src/domain/template-vars.ts):

| Variable | Meaning |
|---|---|
| `${task}` | Raw task line |
| `${task_text}` | Task text without checkbox markup |
| `${file}` | Source file path (relative to cwd) |
| `${context}` | Extracted document context (headings, ancestor sections) |
| `${source}` | Original source argument |
| `${run_id}` | Current run identifier |
| `${attempt}` | 1-based attempt number (in repair phases) |
| `${item}` (in `for:`) | Current iteration item |
| `${scanCount}`, `${existingTodoCount}`, `${hasExistingTodos}` (in plan) | Plan-specific |
| Custom | Anything from `--var key=value`, `--vars-file`, or template-vars-loader |

## External variables — vars files

`--vars-file <file>` loads a JSON or YAML file of additional variables. See [vars-files.md](vars-files.md). The merge order is:

```
built-in vars  →  vars file  →  --var flags  →  per-iteration vars
```

Later layers override earlier.

## Authoring conventions

- Keep variables explicit. Do not rely on environment variables — those are not visible to the worker process by default.
- Multi-line content (e.g. document context) should be inserted as-is; the template engine does not collapse whitespace.
- For dynamic per-task context (sub-items, frontmatter), use the helpers exposed via the template engine; do not concatenate strings ad-hoc in templates.

## Why filesystem templates beat string interpolation in code

- Operators can override prompts without forking the package.
- The `--print-prompt` flow shows the *final* prompt the worker would receive, so debugging is direct.
- CI can vendor approved prompt templates per project.
