# Changelog

## Unreleased

- Fix pre-handoff view work ownership/cancellation and preserve primary errors when
  terminal finalization also fails. Avoid duplicate adapter spans.
- Validate catalog roles independently of filenames and negotiate HTTP JSON/Markdown
  using Accept quality/exclusions, rejecting unsupported representations before execution.
- Add explicit command placement through --out and npm: package-export references
  for reusable document assets, preserving native paths and package export boundaries.

- Replace hidden-directory discovery with nearest-package manifest entry points
  (`rundown.commands` and `rundown.tests`) and explicit `--commands` selection.
- Register existing command/test entry points with --init; atomically update only
  manifest configuration. Source authoring and dependency installation are separate.
- Ship separate example packages demonstrating different source structures.

- Add live JSON views rendered through do-md templates, with explicit closure,
  tracked work, document-relative creation and surface-neutral Markdown rendering.
- Add inline/full-screen CLI hosting, log visibility controls, resize and colored
  Markdown; expose final state/Markdown through CLI, HTTP and MCP.

- Add `context.run(binding, input)` using the existing adapter execution boundary.
- Add `context.callbacks.with` for bounded, scoped registration cleanup.
- Run ordinary Markdown test modules with `--test`, backed by Node's test runner;
  expose `createTestRuntime` through `@p10i/rundown/testing`.
- Document callable authoring contracts, observability and testing through the
  shared CLI/MCP reference and Skill; simplify the callback example and ship tests.

## 2.0.0-rc.2 — unreleased

- Publish release candidates under npm’s `latest` tag so `npm install @p10i/rundown` installs the current candidate.

## 2.0.0-rc.1

- Documentation-first command and universal module formats, compiled with do-md.
- Native ESM imports, circular dependencies, coherent cached artifacts and source maps.
- Faithful JSON constants/defaults, including special keys and signed zero.
- Shared CLI, HTTP, stdio MCP and Streamable HTTP command execution.
- Invocation-scoped callbacks, bounded cleanup, cancellation and related diagnostics.
- Generic adapters and a public bounded process integration; project-owned Markdown
  harness bindings are demonstrated without built-in provider modules.
- Structured logs, declared metrics, OTel export and distributed trace context.
- Skill/reference resources, static checking, scaffolding and catalog connection tooling.
- Canonical package under packages/rundown, installed-artifact tests and platform CI.
- Markdown-only resumable build example with verified artifacts and durable receipts.

This is the first candidate of the new 2.x implementation. It is not published by
the development workflow. Candidate freezing never commits, tags, pushes or publishes.
