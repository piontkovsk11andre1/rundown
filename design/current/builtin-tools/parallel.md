# `parallel:` / `concurrent:` / `par:`

Handler in [src/domain/builtin-tools/parallel.ts](../../implementation/src/domain/builtin-tools/parallel.ts). Group construction in [src/domain/parallel-group.ts](../../implementation/src/domain/parallel-group.ts).

Registration flags:

```ts
{ kind: "handler", frontmatter: { skipExecution: true, autoComplete: true, shouldVerify: false } }
```

## Behavior

- Children of a `parallel:` task that are **inline `cli:` blocks** are dispatched concurrently.
- Children that are not `cli:` blocks are still run sequentially (the parallel handler does not introduce inter-task LLM concurrency — workers are single-shot).
- The parent `parallel:` checkbox is checked when all children complete.

## Why only `cli:` blocks parallelize

Inter-task worker concurrency would break the determinism guarantees:

- multiple workers writing to the same source file would race,
- repair loops cannot share state across workers,
- trace ordering would become non-deterministic.

`cli:` blocks are different: they are bounded subprocesses with deterministic input. Running them concurrently is safe and frequently useful (e.g. parallel test shards, parallel file-system probes).

## Failure semantics

- If any child fails, the parent fails.
- Other in-flight children are allowed to finish (no SIGTERM cascade) — their outputs are still captured for diagnosis.
- Already-completed siblings remain checked.

## Aliases

`parallel:`, `concurrent:`, and `par:` are interchangeable. They register against the same handler.

## Future evolution

This is intentionally narrow. Extending parallelism beyond `cli:` blocks would require redesigning lock scope and verification ordering — out of scope for the current contract.
