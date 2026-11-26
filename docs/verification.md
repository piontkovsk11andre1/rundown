# Verification and development

```sh
npm ci
npm run check
node bin/rundown.mjs --cwd examples/document-processing --check
node bin/rundown.mjs --cwd examples/document-processing pending Target.md
node bin/rundown.mjs --cwd examples/callbacks agent
node bin/rundown.mjs --cwd examples/greeting --test
node bin/rundown.mjs --cwd examples/callbacks --test --json
node bin/rundown.mjs --cwd examples/views --json report
npm pack --dry-run
npm audit
```

The suite exercises the packaged approved-format greeting and other examples,
native ESM circular imports/cache identity, compiler validation/source mapping,
callback queue/close/cancel behavior, HTTP, real SDK stdio/Streamable HTTP clients,
the remote bridge, subprocess cleanup and OTel in-memory exporters.

Author-facing API tests cover context.run defaults/receivers and scoped callback
draining, bounded cleanup and primary failures. Markdown test regressions exercise
real command validation, module assertions, file isolation, source locations,
empty discovery and cleanup failures. An installed tarball executes the shipped
Markdown tests through the public testing entry point.

View tests verify snapshots, explicit closure, continued invocation capabilities,
tracked failures, cancellation and bounded cleanup. CLI, HTTP and MCP checks cover
final state/Markdown and display dimensions. Terminal tests cover Unicode wrapping,
resize, log visibility, full-screen restoration and real POSIX PTY execution using
Python's standard pty module when available (that integration case skips elsewhere).

Review regressions cover work created before view handoff, early tracked failures,
orphan/concurrent view ownership, callback-created resources, terminal-error chains,
single-span adapter execution and Accept quality/exclusions. Authoring/package tests
verify empty catalogs under arbitrary filenames, exact --out placement and encoded
Connections paths, exported document assets, private-subpath rejection and stable
npm: references through registration/connection.

Artifact regressions ensure repeated loads keep metadata/code/maps coherent while
static checks stay fresh and isolated. JSON emission tests cover nested special
keys and signed zero. Generic adapters and the public process entry are exercised
without AI prompts, including original private/prototype method receivers.

Connection tests validate the proposed graph before publication, and separate CLI
processes exercise concurrent metadata updates. The pipeline test interrupts a real
CLI after a receipt exists and verifies resume without rerunning/replacing that
artifact. Absolute-path/Unicode fixtures run on each configured platform.

All implementation `.mjs` modules are checked with strict TypeScript `checkJs` and
explicit JSDoc/internal contracts. `npm run types:internal` uses the compiler API
to resolve implementation files instead of adjacent public declaration stubs;
otherwise TypeScript can silently prefer `.d.mts` files over their source. It
preserves the dependencies' native ESM/CommonJS declaration-resolution modes.

Public `.d.mts` declarations are separately checked with strict TypeScript consumer
fixtures, including expected type failures. They remain maintained declarations.
ESLint and Prettier cover source as well. Markdown implementation bodies pass
Acorn's ESM syntax validation; `checkJs` covers the compiler/runtime, not arbitrary
application bodies embedded in Markdown or template JavaScript strings.

Deadline regressions verify revocation, dropped queued work, shared shutdown
budgets, primary/related error preservation and listener closure after failures.
Diagnostic regressions cover missing files and dependencies, connection chains,
frozen exceptions and arbitrary abort reasons.

Tracing tests exercise real HTTP and SDK MCP requests, separate client/request
contexts, stdio bridge forwarding and an actual child process receiving the
carrier. A local OTLP HTTP collector verifies traces, logs, counters and
histograms exported through standard environment configuration, including W3C
identity and service metadata. This supplements the in-memory exporter tests;
no external telemetry service is required.

Authoring tests copy source fixtures, then run the register/scaffold/check/invoke loop, preserve
existing files and CRLF prose, merge concurrent Connections edits, and compare the
CLI/MCP Skill and reference. Static-check tests include a native dependency whose
top-level code would write a marker: validation resolves it without executing it.
The format registry is shared with parsing/generation; generated reference freshness
is a required check. The public authoring subpath and Skill export are included in
installed-package verification.

Project tests cover nearest-package boundaries, manifest-relative paths, explicit
catalog selection, tests-only packages, ignored undeclared hidden catalogs and
unchanged invocation cwd. Registration preserves metadata and dependency versions,
uses nearest-package boundaries, validates existing targets, supports no-op and
reconfiguration, and refuses concurrent overwrites without generating source files.

Packed-install tests run the shipped CLI, modules and templates in a fresh
consumer installation with nested runtime dependencies. They verify that every
runtime dependency resolves inside that installation rather than leaking from
the development package. They check the executable aliases and
closed internal export boundaries. Implementation fixtures use temporary directories under
`.test-tmp`, which are removed after each case and excluded from packaging.
The Markdown test runner's tiny native entry bridges use the OS temporary directory
and are removed after execution; source documents are not copied or rewritten.
This environment's preallocated external temporary directory is not writable,
so the isolated consumer also uses `.test-tmp`; nested installation and explicit
resolution assertions prevent dependencies from leaking out of the consumer.

The callback example uses a deterministic project-owned Markdown client over real
MCP. The core tracing suite uses generic process/HTTP fixtures, including actual
bounded child processes. These checks require no external provider or installed
client. Installed-package tests verify the public export boundary and the shipped
deterministic callback example.

Local verification is on Linux/Node 24. CI is configured for Ubuntu/Windows on
Node 22.15, 24 and 26; results remain pending until those jobs run. POSIX subprocess cancellation targets the process
group; Windows uses child-process termination and does not claim equivalent
grandchild-tree termination. No Docker image or host service is required.
