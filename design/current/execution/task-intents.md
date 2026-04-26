# Task intents

[src/domain/task-intent.ts](../../implementation/src/domain/task-intent.ts) classifies each task before dispatch. The intent decides which phases run and which can be skipped.

## Six intents

| Intent | Triggers | Phases |
|---|---|---|
| `execute-and-verify` | default — any checkbox with no special prefix | execute → verify → (repair loop) |
| `verify-only` | `verify:` / `confirm:` / `check:` prefix; `include:` after delegated rundown completes | verify → (repair loop) |
| `memory-capture` | `memory:` / `memorize:` / `remember:` / `inventory:` prefix | execute → write to memory store; no verify |
| `tool-expansion` | any registered tool prefix that is not `verify`/`memory`/`parallel` (`for:`, `include:`, `optional:`, `skip:`, …) | tool handler runs; tool decides what executes underneath |
| `parallel-group` | `parallel:` / `concurrent:` / `par:` prefix | native dispatch — direct child `cli:` blocks run concurrently; non-`cli:` children remain sequential. See [parallel.md](../builtin-tools/parallel.md). |
| `fast-execution` | `fast:` / `raw:` / `quick:` prefix | execute only — verification and repair are both skipped |

## Resolution

Resolution happens in [run-task-iteration.ts](../../implementation/src/application/run-task-iteration.ts) before dispatch:

1. Tokenize the task's leading prefixes (e.g. `profile=fast force: verify:`).
2. Modifiers (`profile=`, `force:`) attach metadata but do not change intent. (`force:` is a registered `modifier`-kind tool — see [src/domain/builtin-tools/index.ts](../../implementation/src/domain/builtin-tools/index.ts).)
3. The first non-modifier prefix wins.
4. If the prefix is registered as a tool (built-in or project-level `.md` / `.js` file under `.rundown/tools/`), the intent becomes `tool-expansion` and the tool handler controls subsequent phases via its `frontmatter` (e.g. `skipExecution: true`).
5. If no prefix is present, the intent is `execute-and-verify`.

## Intent flags

Built-in tool definitions provide three flags that the dispatcher honors:

| Flag | Effect |
|---|---|
| `skipExecution: true` | Skip the worker/cli execution; the tool handler runs instead. |
| `shouldVerify: true` | Run a verification phase after the handler/execution. |
| `autoComplete: true` | The tool handler is responsible for completion; the standard verify-then-check path is bypassed. |

See [src/domain/builtin-tools/index.ts](../../implementation/src/domain/builtin-tools/index.ts) for the canonical flag values per tool.

## Examples

```markdown
- [ ] Implement endpoint                 ← execute-and-verify (default)
- [ ] verify: response is 200 OK         ← verify-only
- [ ] memory: capture API response shape ← memory-capture
- [ ] for: each modified file in src/    ← tool-expansion
- [ ] parallel: smoke checks             ← parallel-group
- [ ] fast: best-effort cleanup          ← fast-execution (aliases: `raw:`, `quick:`)
- [ ] profile=fast verify: lint clean    ← verify-only with profile
```
