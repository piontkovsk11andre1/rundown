# Glossary

Terminology used across `design/current/`. Definitions reflect current implementation, not aspirational meaning.

| Term | Meaning |
|---|---|
| **Task** | A GFM checkbox list item parsed from a Markdown source file. |
| **Source** | A file, directory, or glob accepted by commands like `run`, `plan`, `discuss`. Resolved through `SourceResolverPort`. |
| **Worker** | An external process invoked to execute, verify, or repair a task. Configured via worker pattern + arguments. |
| **Worker pattern** | The argv template (e.g. `["opencode", "run", "--file", "$file", "$bootstrap"]`) with placeholders. |
| **Profile** | A named worker configuration entry under `profiles.<name>` in `config.json`. Selectable from frontmatter, directives, or `profile=` prefix. |
| **Intent** | A classification of a task that controls dispatch: `execute-and-verify`, `verify-only`, `memory-capture`, `tool-expansion`, `fast-execution`. |
| **Built-in tool** | A prefix-named handler registered in [src/domain/builtin-tools/](../../implementation/src/domain/builtin-tools/) (e.g. `verify:`, `for:`, `include:`). |
| **Inline CLI block** | A task whose text starts with `cli:`; rundown executes the rest as a shell command and captures its result instead of calling a worker. |
| **Phase** | One of `execute`, `verify`, `repair`, `resolve`, `plan`, `discuss`, `rundown-delegate`, `pre-run-reset`, `post-run-reset`. Used in artifacts and traces. |
| **Run** | One invocation of a command against one or more sources. Identified by a run-id; produces a directory under `.rundown/runs/`. |
| **Round** | One full pass of the run loop; `--rounds N` repeats the pass `N` times. |
| **Artifact** | Persisted on-disk record of one phase: prompt, stdout, stderr, metadata. Stored under `.rundown/runs/<run-id>/<seq>-<phase>/`. |
| **Trace** | A typed event stream describing a run; written through `TraceWriterPort` (default no-op, optional JSONL). |
| **Verification store** | The sidecar storage for per-task verification results (`<file>.<index>.validation`). |
| **Lockfile** | A per-source `.rundown/<basename>.lock` file colocated with the source, preventing concurrent rundown instances from touching the same Markdown file. |
| **Config dir** | The effective `.rundown/` directory, resolved by upward walk from the working dir or set explicitly via `--config-dir`. |
| **Migration** | A numbered Markdown file under `migrations/`, e.g. `7. Implement Feature.md`. |
| **Pending migration** | A numbered migration file in `migrations/` that records planner-authored intent until external lifecycle tooling consumes it. |
| **Materialize** | Convenience for `run --all --revertable` against a migration; produces per-task commits aligned with the migration track. |
| **Composition root** | [src/create-app.ts](../../implementation/src/create-app.ts) — the only place where ports are wired to adapters. |
