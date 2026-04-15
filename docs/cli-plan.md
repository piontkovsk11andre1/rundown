# CLI: `plan`

Run document-level TODO synthesis on a single Markdown document using the planner template.

For thin specs, run `research` first so `plan` has richer context:

```bash
rundown research docs/spec.md
rundown plan docs/spec.md --scan-count 3
```

`plan` treats the full document as intent input. It creates actionable TODOs when none exist, then runs clean-session coverage scans that append only missing TODO items until convergence or the scan cap is reached.

When `--deep <n>` is set, `plan` then runs `n` additional nested passes after top-level scan convergence. Each deep pass targets current leaf TODO items (parents with no checkbox children) and asks the planner for child `- [ ]` items only.

Input rules:

- Exactly one file path is required.
- File extension must be `.md` or `.markdown`.
- Legacy task selection flags (`--at`, `--sort`) are rejected for `plan`.

Options:

| Option | Description | Default |
|---|---|---|
| `--scan-count <n>` | Maximum clean-session scan iterations. Must be a safe positive integer. | `3` |
| `--max-items <n>` | Maximum total TODO items allowed in the document after each scan merge. Planning stops once this cap is reached. Must be a safe non-negative integer. | unset |
| `--deep <n>` | Additional nested planning passes after top-level scans. Must be a safe non-negative integer (`0` disables deep passes). | `0` |
| `--mode <mode>` | Planner execution mode. Currently only `wait` is supported. | `wait` |
| `--force-unlock` | Remove stale source lockfile before acquiring the planner lock. Active locks held by live processes are not removed. | off |
| `--dry-run` | Render plan prompt + execution intent and exit without running the worker. | off |
| `--print-prompt` | Print the rendered planner prompt and exit `0` without running the worker. | off |
| `--keep-artifacts` | Preserve runtime artifacts under `<config-dir>/runs/` even on success. | off |
| `--show-agent-output` | Show planner worker stdout/stderr during execution (hidden by default). | off |
| `--no-show-agent-output` | Explicitly hide planner worker stdout/stderr during execution. Useful to override prior toggles. | on (effective default) |
| `--trace` | Write structured trace events to `<config-dir>/runs/<id>/trace.jsonl` and mirror them to `<config-dir>/logs/trace.jsonl`. | off |
| `--vars-file [path]` | Load template variables from JSON (default path: `<config-dir>/vars.json`). | unset |
| `--var <key=value>` | Inject template variables (repeatable). | none |
| `--ignore-cli-block` | Skip `cli` fenced-block command execution during prompt expansion. | off |
| `--cli-block-timeout <ms>` | Per-command timeout for `cli` fenced-block execution (`0` disables timeout). | `30000` |
| `--worker <pattern>` | Worker pattern override (preferred on PowerShell). | unset |

Worker resolution:

- `--worker <pattern>` and separator form `-- <command>` are both supported.
- If neither is provided, `plan` resolves the worker from `.rundown/config.json` using the standard resolution cascade.
- For OpenCode workers, continuation/resume session arguments are rejected so each scan runs in a clean session.

Scan loop and convergence semantics:

- Scans run from `1..scan-count` and always read the latest on-disk document before each pass.
- Each scan may only add TODO lines; edits/deletes/reorders of existing TODO text are rejected.
- Converges early when either:
  - worker output is empty, or
  - worker output contains no valid new TODO additions after normalization/idempotency checks.
- If no convergence signal occurs before the limit, planning stops at the configured scan cap.

Deep pass semantics (`--deep`):

- `--deep 0` (default): behavior is unchanged; only top-level scan coverage runs.
- Deep passes run after top-level scans, from `1..deep`.
- Before each deep pass, `plan` re-reads and re-parses the latest on-disk document.
- Each deep pass runs clean worker sessions per parent task and only inserts child TODO lines beneath that parent.
- Deep planning converges early when a pass has no candidate leaf tasks or when no child TODO lines are added.
- `--print-prompt` and `--dry-run` include deep-pass behavior preview when `--deep > 0`.

Artifacts and audit expectations:

- Scan phases are recorded with deterministic labels (`plan-scan-01`, `plan-scan-02`, ...).
- Run metadata includes convergence fields (`planConvergenceOutcome`, `planConverged`, `planScanCapReached`, `planEmergencyCapReached`, plus scan counts).
- Failed planning runs keep artifacts automatically.
- Successful runs are pruned by default unless `--keep-artifacts` is set.

Examples:

```bash
# Basic plan run
rundown plan roadmap.md --scan-count 3

# No TODOs yet: bootstrap actionable TODOs, then converge
rundown plan docs/spec.md --scan-count 3

# Existing TODOs: append missing implementation items only
rundown plan docs/migration.md --scan-count 2

# Add one nested layer of child TODOs after top-level scans
rundown plan docs/spec.md --scan-count 3 --deep 1

# Add two nested layers (children, then grandchildren)
rundown plan docs/spec.md --scan-count 3 --deep 2

# PowerShell-safe worker form
rundown plan docs/spec.md --scan-count 2

# PowerShell-safe deep planning
rundown plan docs/spec.md --scan-count 2 --deep 2
```
