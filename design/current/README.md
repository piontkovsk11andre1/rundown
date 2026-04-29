# Rundown — Current Design

This directory is the living design specification of the [implementation/](../../implementation/) source tree and the GitHub-side automation that orchestrates it. Each subdirectory groups related design decisions into small, focused files; revisions of this directory are snapshotted via `rd design release` into sibling `design/rev.N/` directories and drive the migration track.

## How this directory is structured

- One subdirectory per concern.
- Each subdirectory has its own `README.md` index listing the files inside it and what they cover.
- Files are intentionally short and single-topic. When a topic grows, split it rather than letting a file become a long unstructured document.
- Cross-references use repository-relative links so they survive `design release` snapshots unchanged.

## Index

| Section | Topic |
|---|---|
| [overview/](overview/README.md) | What `rundown` is, why it exists, and the prediction model that frames everything |
| [architecture/](architecture/README.md) | Hexagonal layering, ports/adapters, composition root, module map |
| [execution/](execution/README.md) | The workload protocol: parse → select → execute → verify → repair → complete |
| [lifecycle/](lifecycle/README.md) | Design release, migrate (planner loop), materialize, undo/revert, test |
| [workers/](workers/README.md) | Worker configuration, resolution order, patterns, execution modes, routing, health |
| [builtin-tools/](builtin-tools/README.md) | Built-in prefix tools (`verify:`, `for:`, `parallel:`, `include:`, `memory:`, …) |
| [cli/](cli/README.md) | Full command surface, options, and CLI behavior contracts |
| [configuration/](configuration/README.md) | `.rundown/` discovery, `config.json` schema, frontmatter, templates, locale |
| [project-layout/](project-layout/README.md) | Recommended workspace shape and memory layout |
| [ci/](ci/README.md) | GitHub Actions workflows and the agentic loop wiring |
| [packaging/](packaging/README.md) | NPM package shape, TypeScript build, test runner |

## Scope and source of truth

- This directory describes **current intent**, not historical context. Past changes live in the migration track under [migrations/](../../migrations/).
- It must stay in sync with [implementation/src/](../../implementation/src/) and [.github/](../../.github/). Any drift is treated as a design defect.
- When implementation changes, the corresponding design files here change in the same PR; the migration is the bridge between the two.
