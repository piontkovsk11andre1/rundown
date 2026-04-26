# Execution modes

Three modes select how rundown talks to the spawned worker process. Implemented in [src/infrastructure/runner.ts](../../implementation/src/infrastructure/runner.ts).

## `wait`

Default for non-interactive commands (`run`, `plan`, `materialize`, `reverify`, `research`, `query`, `translate`, `make`, `add`, `explore`, `do`).

- Stdout and stderr piped and **fully buffered** in memory.
- Returned as `WorkerRunResult` with `stdout`, `stderr`, `exitCode`, `durationMs`.
- Subject to `workerTimeoutMs`: on expiry, rundown sends `SIGTERM` and produces a deterministic stderr line `Worker process timed out after <N>ms.`.
- Used for everything that needs structured output for verification, memory capture, or planning.

## `tui`

Default for `discuss` and interactive `with` invocations, also chosen by `workers.tui` when the worker is an interactive harness.

- `stdio: "inherit"` — the worker takes the terminal.
- Optionally taps streams to mirror them into artifacts (for trace fidelity).
- Subject to `workerTimeoutMs` (the timeout still applies; users can disable with `0`).
- Returned with whatever exit code the user produced when they exited the TUI.

## `detached`

Triggered by `--detached` (where supported) or hooks that want to fire-and-forget.

- `stdio: "ignore"`, `detached: true`, `unref()`.
- Returns immediately with `exitCode: null` and a `detached` run status.
- **Not** subject to `workerTimeoutMs` (rundown is no longer monitoring the process).
- No artifacts captured beyond the prompt file.
- Use sparingly; verification cannot run on detached executions.

## Mode selection

Mode is decided by the use case based on:

1. an explicit `--detached` flag where exposed,
2. whether the resolved worker came from `workers.tui`,
3. the command's default (e.g. `discuss` defaults to TUI),
4. otherwise `wait`.

There is no user-facing `--mode` flag; mode follows from semantics. This keeps the command set free of "what mode am I in?" surprises.

## Output capture and artifacts

In `wait` and `tui` modes:

- `stdout.log` and `stderr.log` are written under `<run-dir>/<seq>-<phase>/`.
- `metadata.json` records argv, exit code, duration, transport, and worker failure classification.

In `detached` mode:

- only `prompt.md` and `metadata.json` (with `transport: "detached"`, no exit code) are written.

## Source-file safety

In all modes, the worker's `cwd` is the directory of the *invocation* (or the source-file directory for source-scoped flows). The worker has read access to the source Markdown but **must not** modify it directly. All checkbox mutations go through rundown's completion path. The verification phase confirms checkbox integrity; verification fails if a worker unexpectedly toggled the box.

For workflows where the worker legitimately needs to *edit* a Markdown file under control, use `include:` (which clones the file into a runtime artifact directory and runs a nested rundown over the clone).
