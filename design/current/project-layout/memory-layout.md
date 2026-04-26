# Memory layout

Layout under `<config-dir>/memory/`, used by [`memory:` tools](../builtin-tools/memory.md).

```
<config-dir>/memory/
├── global/                # shared across all sources
│   └── <topic>.md
├── source/                # scoped to a single Markdown source
│   └── <source-basename>/
│       └── <topic>.md
├── task/                  # scoped to a single task
│   └── <run-id>/<task-hash>/<topic>.md
└── prefixes/              # per-prefix memory (e.g. for plan/verify)
    └── <prefix>/<topic>.md
```

## Scopes

| Scope | Lifetime | Access pattern |
|---|---|---|
| `global` | Persists across runs and sources | Available to any task on any source |
| `source` | Persists across runs of the same source | Available only when running that source |
| `task` | Persists for the run and any nested re-runs of the same task | Available to a single task across its repair attempts |
| `prefix` | Persists across all tasks that use a given prefix | Available to tools that opt in (e.g. `plan` looks at its prefix memory before planning) |

## Write paths

`memory:` tasks always write into the **task** scope unless the prefix or sub-items specify otherwise. Patterns:

- `memory: capture <topic>` — task scope (default).
- `memory.global: capture <topic>` — global scope.
- `memory.source: capture <topic>` — source scope.

Built-in helpers prefix-match these aliases at parse time.

## Read paths

When a task runs, `MemoryReadPort.readForTask(task, source)` returns:

1. global memory matching topics referenced in the task,
2. source memory for the source,
3. task memory for the prior attempts of this exact task,
4. prefix memory for the task's prefix.

The order is preserved in the prompt so newer/more-specific memory wins narratively.

## File format

Each memory file is plain Markdown with YAML frontmatter:

```markdown
---
topic: usage-limit-handling
captured-at: 2026-04-25T14:33:00Z
captured-by: opencode/claude-sonnet
run-id: 2026-04-25T14-30-12
---

The opencode CLI returns exit code 6 when the model usage limit is exhausted.
Wait at least 60s before retrying. ...
```

This format is human-readable, diff-friendly, and re-ingestable by tools.

## Cleanup

`task` scope is purged automatically by `clean --task` (run-id-bounded). `global` and `source` scopes are never auto-purged — users decide what to keep.
