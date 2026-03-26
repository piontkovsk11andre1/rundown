# Plan: Structured Observability Tracing for Rundown

## TL;DR

Add `--trace` flag to all task commands (run, reverify, plan) that produces structured JSONL trace files in `.rundown/runs/<id>/trace.jsonl`. Trace events are generated in a hybrid approach: deterministic events from artifacts/timings plus an LLM enrichment pass using a customizable `.rundown/trace.md` template. Default prompts gain a conditional `{{traceInstructions}}` block that asks agents to emit lightweight structured signals when tracing is active.

## Phase 1: Deterministic Trace Infrastructure

### Steps

1. **Define trace event schemas** — Create `src/domain/trace.ts` with TypeScript interfaces for all trace event types. Each event includes `schema_version: 1`, `timestamp`, `run_id`, `event_type`, and type-specific payload. Event types:
   - `run.started` — run_id, command, source, worker, mode, transport, task text/file/line
   - `phase.started` — phase (execute/verify/repair/plan), sequence, command
   - `phase.completed` — phase, sequence, exit_code, duration_ms, stdout_bytes, stderr_bytes, output_captured
   - `verification.result` — outcome (pass/fail), failure_reason, attempt_number
   - `repair.attempt` — attempt_number, max_attempts, previous_failure
   - `repair.outcome` — final_valid, total_attempts
   - `task.completed` — task_text, task_file, task_line, total_duration_ms, phases_count
   - `task.failed` — task_text, reason, exit_code, final_status
   - `run.completed` — status, total_duration_ms, total_phases

2. **Create trace writer port** — `src/domain/ports/trace-writer-port.ts` with `TraceWriterPort` interface: `write(event: TraceEvent): void`, `flush(): void`. This keeps trace output pluggable.

3. **Create JSONL trace writer adapter** — `src/infrastructure/adapters/jsonl-trace-writer.ts` implementing `TraceWriterPort`. Appends one JSON line per event to `.rundown/runs/<id>/trace.jsonl`. Buffers minimally, flushes on `flush()`.

4. **Create noop trace writer** — For when `--trace` is not active. Zero overhead.

5. **Wire trace writer into `AppPorts`** — Add `traceWriter: TraceWriterPort` to `AppPorts`. Default: noop. When `--trace` is active: JSONL writer.

6. **Emit deterministic events from run-task.ts** — Instrument the run lifecycle:
   - `run.started` at the top of `runTask()`
   - `phase.started` / `phase.completed` around each worker execution (reuse timing from artifact phase metadata)
   - `verification.result` after each verify call
   - `repair.attempt` / `repair.outcome` from repair loop
   - `task.completed` or `task.failed` at the end
   - `run.completed` as the final event

7. **Add `--trace` flag to CLI** — On `run`, `reverify`, `plan` commands. Passes `trace: boolean` into options. When true, creates JSONL trace writer at artifact context creation time.

## Phase 2: Worker Output Enrichment (Thinking + Structured Signals)

### Steps

8. **Auto-inject `--thinking` for opencode when tracing** — In `buildOpenCodeArgs()` (runner.ts), when `--trace` is active, auto-append `--thinking` to opencode args. This surfaces the model's chain-of-thought between tool calls. Pass a `trace: boolean` flag through `RunnerOptions` to control this.

9. **Support `--format json` for opencode (DEFERRED)** — Initially considered injecting `--format json` for structured event parsing. **Rejected** because it breaks verification (stdout becomes JSON events instead of parseable `OK`/`NOT_OK`), breaks user-visible output, and adds parsing complexity. The value (structured tool calls, token counts) is marginal vs. what `--thinking` + `rundown-trace` fenced block already provide. Can revisit if opencode adds a sidecar/file output mode for structured events.

10. **Create worker output parser** — `src/domain/worker-output-parser.ts`: Parses formatted text stdout for trace-relevant content:
    - Extract thinking blocks from opencode `--thinking` output (regex-based, looking for opencode's thinking delimiters)
    - Extract `rundown-trace` fenced blocks (for all workers)
    - Parser is text-based and worker-agnostic — new workers can be supported by adding delimiter patterns

11. **Define parsed worker output structure** — `WorkerOutputAnalysis`:
    - `thinking_blocks`: array of `{ content: string }` — reasoning extracted from `--thinking` output
    - `tool_calls`: array of tool names (extracted from `rundown-trace` block's `tools_used` field)
    - `agent_signals`: optional parsed `rundown-trace` block (confidence, files, approach, etc.)
    - `raw_stdout`: original stdout preserved

12. **Add `{{traceInstructions}}` template variable** — In `run-task.ts`, set to instruction block when `--trace` is active, empty string when not.

13. **Define trace instruction block content** — For non-opencode workers (or as supplementary signal), asks the agent to append:
    ```
    ```rundown-trace
    confidence: <0-100>
    files_read: <comma-separated list>
    files_written: <comma-separated list>
    tools_used: <comma-separated list>
    approach: <one-line summary>
    blockers: <issues or "none">
    ```
    ```
    Simple key-value — works with small models. For opencode with `--format json`, most of this data comes from structured events instead, making the fenced block supplementary (confidence + approach are still useful).

14. **Update default templates** — Append `{{traceInstructions}}` to each template in defaults.ts. Renders empty when tracing off.

15. **Parse agent trace block from stdout** — `src/domain/trace-parser.ts`: Extract `rundown-trace` fenced block from worker stdout. Return parsed key-value pairs or null.

16. **Emit rich trace events from parsed output** — After each phase completes:
    - `agent.signals` — confidence, files_read/written, tools_used, approach, blockers
    - `agent.thinking` — array of thinking block summaries (count, total chars, key themes if short)
    - `agent.tool_usage` — list of tools from rundown-trace block

## Phase 3: LLM Enrichment Pass

### Steps

17. **Create `.rundown/trace.md` default template** — *depends on steps 1-6*. A new template that receives the full run context: all phase outputs, timings, agent signals, **thinking blocks**, tool call logs, task info. Asks the LLM to produce structured analysis. The thinking blocks are the richest signal — they reveal decision quality, uncertainty, and direction changes that can't be inferred from final output alone.

18. **Define enrichment event types**:
    - `analysis.summary` — LLM-generated analysis of the run:
      - `task_complexity`: low/medium/high/critical
      - `execution_quality`: clean/minor_issues/significant_issues/failed
      - `direction_changes`: number of times the approach shifted (inferred from thinking blocks)
      - `modules_touched`: list of code areas/modules revised
      - `wasted_effort_pct`: estimate of work that was thrown away or redone
      - `key_decisions`: list of important architectural/implementation decisions
      - `risk_flags`: potential issues introduced
      - `improvement_suggestions`: what could make this task faster next time
      - `skill_gaps`: areas where the agent struggled
      - `similar_past_patterns`: what this task reminds of
      - `thinking_quality`: how well-structured the reasoning was (clear/scattered/circular)
      - `uncertainty_moments`: count of moments where the agent expressed doubt

19. **Run trace enrichment as final phase** — After the main run completes (success or failure), if `--trace` is active:
    - Gather all phase metadata, stdout/stderr, agent signals, timing data
    - Render `.rundown/trace.md` template with this context
    - Execute the worker one more time with the trace prompt
    - Parse structured output into `analysis.summary` event
    - Append to trace.jsonl

20. **Add `--trace-only` flag** — Run trace enrichment on an existing artifact run without re-executing. Useful for retroactive analysis of past runs.

## Phase 4: Rich Deterministic Metrics

### Steps

21. **Prompt size metrics** — *parallel with phase 2*. Emit `prompt.metrics` event per phase:
    - `char_count`: prompt length
    - `estimated_tokens`: chars / 4 (rough estimate)
    - `context_ratio`: % of prompt that is document context vs instructions
    - `template_name`: which template was used

22. **Timing waterfall** — *from artifact metadata*. Emit `timing.waterfall` event at run end:
    - Array of `{ phase, sequence, started_at, completed_at, duration_ms }`
    - `idle_time_ms`: gaps between phases (time spent in rundown overhead)
    - `total_wall_time_ms`
    - `total_worker_time_ms`

23. **Verification efficiency metrics** — Emit `verification.efficiency` event:
    - `first_pass_success`: boolean
    - `total_verify_attempts`: count
    - `total_repair_attempts`: count
    - `verification_to_execution_ratio`: verify_time / execute_time
    - `cumulative_failure_reasons`: list of all failure reasons seen

24. **Output volume metrics** — Per phase: `stdout_bytes`, `stderr_bytes`, `stdout_lines`, `stderr_lines`. Helps detect verbose/silent agents.

25. **Task selection context** — `task.context` event:
    - `source_files_scanned`: count
    - `total_unchecked_tasks`: count across all files
    - `task_position_in_file`: index relative to total tasks in file
    - `document_context_lines`: lines of context before task
    - `has_subtasks`: boolean
    - `is_inline_cli`: boolean
    - `is_verify_only`: boolean

## Relevant Files

- [src/domain/trace.ts](src/domain/trace.ts) — NEW: trace event type definitions and schema
- [src/domain/trace-parser.ts](src/domain/trace-parser.ts) — NEW: parse agent trace blocks from stdout (fenced block format)
- [src/domain/worker-output-parser.ts](src/domain/worker-output-parser.ts) — NEW: universal worker output parser abstraction (opencode JSON + plain text)
- [src/domain/ports/trace-writer-port.ts](src/domain/ports/trace-writer-port.ts) — NEW: trace writer port interface
- [src/domain/ports/index.ts](src/domain/ports/index.ts) — Add TraceWriterPort export
- [src/infrastructure/adapters/jsonl-trace-writer.ts](src/infrastructure/adapters/jsonl-trace-writer.ts) — NEW: JSONL file writer
- [src/infrastructure/adapters/index.ts](src/infrastructure/adapters/index.ts) — Export new adapters
- [src/domain/defaults.ts](src/domain/defaults.ts) — Add DEFAULT_TRACE_TEMPLATE, update existing templates with `{{traceInstructions}}`
- [src/domain/template.ts](src/domain/template.ts) — No changes needed (existing engine handles new vars)
- [src/application/run-task.ts](src/application/run-task.ts) — Instrument with trace event emission, add trace enrichment pass, wire traceInstructions var
- [src/application/verify-repair-loop.ts](src/application/verify-repair-loop.ts) — Pass trace writer through, emit verification events
- [src/application/reverify-task.ts](src/application/reverify-task.ts) — Add --trace support
- [src/application/plan-task.ts](src/application/plan-task.ts) — Add --trace support
- [src/create-app.ts](src/create-app.ts) — Wire TraceWriterPort into AppPorts
- [src/presentation/cli.ts](src/presentation/cli.ts) — Add `--trace` and `--trace-only` flags to run/reverify/plan
- [src/infrastructure/runner.ts](src/infrastructure/runner.ts) — Auto-inject `--thinking` and `--format json` for opencode when tracing; add `trace` flag to RunnerOptions
- [src/infrastructure/templates-loader.ts](src/infrastructure/templates-loader.ts) — Load `.rundown/trace.md`
- [src/application/init-project.ts](src/application/init-project.ts) — Generate trace.md on init

## Verification

1. **Unit tests** for trace event schema construction (`__tests__/domain/trace.test.ts`)
2. **Unit tests** for trace block parser — valid block, missing block, malformed block (`__tests__/domain/trace-parser.test.ts`)
3. **Unit tests** for JSONL writer — writes valid JSONL, handles flush (`__tests__/infrastructure/adapters/jsonl-trace-writer.test.ts`)
4. **Integration test** — Run with `--trace`, verify `trace.jsonl` exists and contains expected event types
5. **Integration test** — Run without `--trace`, verify no trace file is created and no overhead
6. **Integration test** — Verify `{{traceInstructions}}` renders empty when trace is off, renders content when on
7. **Manual verification** — Pipe trace.jsonl through `jq` to confirm Promtail/Loki-compatible format
8. **Manual verification** — Dashboard mockup: import trace.jsonl into Grafana with Loki, verify useful queries

## Decisions

- **Flag name**: `--trace` (aligns with OpenTelemetry terminology)
- **Output destination**: File at `.rundown/runs/<id>/trace.jsonl` (not stdout, to avoid polluting command output)
- **Template enrichment**: Conditional via `{{traceInstructions}}` variable — zero impact when tracing is off
- **Schema versioning**: Include `schema_version: 1` in every event for safe future evolution
- **Agent signal format**: Simple key-value in fenced block (not JSON) — works with small models
- **Trace template**: User-customizable `.rundown/trace.md` (fits existing template pattern)
- **Scope**: All task commands (run, reverify, plan)
- **Approach**: Hybrid — deterministic metrics from artifacts + LLM enrichment pass for qualitative analysis

## Trace Event Catalog (Summary)

| Event Type | Source | Key Fields |
|---|---|---|
| `run.started` | deterministic | command, source, worker, mode, task |
| `phase.started` | deterministic | phase, sequence, command |
| `phase.completed` | deterministic | phase, duration_ms, exit_code, stdout_bytes |
| `prompt.metrics` | deterministic | char_count, estimated_tokens, context_ratio |
| `agent.signals` | parsed from stdout | confidence, files, tools, approach, blockers |
| `agent.thinking` | parsed from --thinking output | thinking_blocks_count, total_thinking_chars |
| `agent.tool_usage` | parsed from rundown-trace block | tools list from agent self-report |
| `verification.result` | deterministic | outcome, failure_reason, attempt |
| `repair.attempt` | deterministic | attempt_number, previous_failure |
| `repair.outcome` | deterministic | final_valid, total_attempts |
| `verification.efficiency` | deterministic | first_pass, verify_count, repair_count |
| `timing.waterfall` | deterministic | per-phase durations, idle_time, wall_time |
| `task.context` | deterministic | files_scanned, total_tasks, position, flags |
| `task.completed` / `task.failed` | deterministic | total_duration, phases_count, status |
| `analysis.summary` | LLM enrichment | complexity, quality, decisions, risk_flags, waste, thinking_quality |
| `run.completed` | deterministic | final_status, total_duration |

## Grafana Dashboard Value

With these events, a team can build dashboards showing:
- **Execution velocity**: tasks completed per hour/day, average completion time
- **Verification health**: first-pass success rate, average repair attempts needed
- **Agent efficiency**: confidence distribution, wasted effort trends, direction changes
- **Bottleneck detection**: which phases take longest, verification-to-execution time ratio
- **Task complexity trends**: complexity distribution, correlation with duration
- **Quality signals**: risk flags over time, skill gaps recurring across runs
- **Prompt economics**: token estimates per phase, context ratio optimization
- **Failure patterns**: common failure reasons, repair success rate by failure type

---

## Implementation

- Phase 1: Deterministic Trace Infrastructure
  - Domain types and ports
    - [x] Create `src/domain/trace.ts` with TypeScript interfaces for all trace event types: base `TraceEvent` with `schema_version`, `timestamp`, `run_id`, `event_type`, and discriminated union payloads for `run.started`, `phase.started`, `phase.completed`, `verification.result`, `repair.attempt`, `repair.outcome`, `task.completed`, `task.failed`, `run.completed`. Export a factory function per event type.
    - [x] Create `src/domain/ports/trace-writer-port.ts` with a `TraceWriterPort` interface exposing `write(event: TraceEvent): void` and `flush(): void`. Follow the existing port pattern (e.g. `Clock`).
    - [x] Export `TraceWriterPort` from `src/domain/ports/index.ts` following the existing `export type` re-export pattern.
  - Adapters
    - [x] Create `src/infrastructure/adapters/jsonl-trace-writer.ts` implementing `TraceWriterPort`. Factory function `createJsonlTraceWriter(filePath: string, fs: FileSystem): TraceWriterPort`. Ensure the parent directory exists (via `mkdirSync` with `recursive: true`) on first `write()` call. Appends one `JSON.stringify(event) + "\n"` per `write()` call. `flush()` is a no-op for append-mode writes.
    - [x] Create `src/infrastructure/adapters/noop-trace-writer.ts` with `createNoopTraceWriter(): TraceWriterPort`. Both methods are no-ops. Zero overhead when tracing is off.
    - [x] Export both new adapter factories from `src/infrastructure/adapters/index.ts`.
  - Wiring
    - [x] Add `traceWriter: TraceWriterPort` to the `AppPorts` interface in `src/create-app.ts`. Default to `createNoopTraceWriter()` in the `createAppPorts()` factory using the existing `overrides ?? default` pattern.
    - [x] Add `trace: boolean` field to `RunTaskOptions` in `src/application/run-task.ts`, `ReverifyOptions` in `src/application/reverify-task.ts`, and `PlanOptions` in `src/application/plan-task.ts`. Thread the flag through to runner options and trace writer construction.
  - Event emission
    - [x] Instrument `src/application/run-task.ts` to emit deterministic trace events via `ports.traceWriter`: `run.started` at entry, `phase.started`/`phase.completed` around each worker invocation, `task.completed` or `task.failed` at exit, and `run.completed` as the final event. Wrap the main execution in try/finally to guarantee `task.failed` and `run.completed` events are emitted even on unexpected errors. Call `flush()` at the end.
    - [x] Instrument `src/application/verify-repair-loop.ts` to emit `verification.result` after each verify call, `repair.attempt` before each repair execution, and `repair.outcome` after the loop concludes. Accept `traceWriter` via the existing ports/options pattern.
    - [x] Instrument `src/application/reverify-task.ts` to emit trace events via `ports.traceWriter`: `run.started` at entry, delegate to `verify-repair-loop.ts` for verification/repair events, and `run.completed` at exit. Call `flush()` at the end.
    - [x] Instrument `src/application/plan-task.ts` to emit trace events via `ports.traceWriter`: `run.started` at entry, `phase.started`/`phase.completed` around the planning worker invocation, and `run.completed` at exit. Call `flush()` at the end.
  - CLI flag
    - [x] Add `--trace` boolean flag to the `run`, `reverify`, and `plan` commands in `src/presentation/cli.ts`. Pass `trace: boolean` through to run options. When true, construct a `createJsonlTraceWriter` targeting `.rundown/runs/<id>/trace.jsonl` and pass it as the `traceWriter` port override.
  - Tests
    - [x] Create `__tests__/domain/trace.test.ts` — unit tests for trace event factory functions: validate `schema_version`, `event_type`, required fields, and timestamp format for each event type.
    - [x] Create `__tests__/infrastructure/adapters/jsonl-trace-writer.test.ts` — unit tests: write multiple events, read the file back, verify each line is valid JSON with correct `event_type`. Test flush behavior.
    - [x] Create `__tests__/infrastructure/adapters/noop-trace-writer.test.ts` — verify both methods exist and do not throw.
    - [x] Add integration test in `__tests__/integration/cli.test.ts` — run with `--trace` flag, verify `.rundown/runs/` contains a `trace.jsonl` with `run.started` and `run.completed` events. Run without `--trace`, verify no trace file is created.
    - [x] Update import boundary tests (`__tests__/domain/import-boundary.test.ts`, `__tests__/infrastructure/import-boundary.test.ts`) to include new domain files (`trace.ts`, `trace-parser.ts`, `worker-output-parser.ts`), ports (`trace-writer-port.ts`), and adapters (`jsonl-trace-writer.ts`, `noop-trace-writer.ts`).
    - [x] Export trace-related public types (`TraceEvent`, `TraceWriterPort`) from `src/index.ts` and update `__tests__/integration/public-api-exports.test.ts` to verify them.
- Phase 2: Worker Output Enrichment
  - Runner changes
    - [x] Add `trace: boolean` field to `RunnerOptions` in `src/infrastructure/runner.ts`. When true and the worker is `opencode`, auto-append `--thinking` to the built command args in `buildOpenCodeArgs()`.
  - Parsers
    - [x] Create `src/domain/trace-parser.ts` — export `parseTraceBlock(stdout: string): Record<string, string> | null`. Extract the first fenced code block tagged `rundown-trace` from stdout. Parse its key-value lines (`key: value`) into a record. Return null if no block found.
    - [x] Create `src/domain/worker-output-parser.ts` — export `parseWorkerOutput(stdout: string): WorkerOutputAnalysis`. Define `WorkerOutputAnalysis` interface with `thinking_blocks: { content: string }[]`, `tool_calls: string[]`, `agent_signals: Record<string, string> | null`, `raw_stdout: string`. Extract thinking blocks via regex for opencode thinking delimiters, extract `rundown-trace` block via `parseTraceBlock`, and populate `tool_calls` from the `tools_used` field.
  - Template variable
    - [x] Add `{{traceInstructions}}` template variable injection to `src/application/run-task.ts`, `src/application/reverify-task.ts`, and `src/application/plan-task.ts`. When `trace` is active, set it to the instruction block asking the agent to emit a `rundown-trace` fenced block with `confidence`, `files_read`, `files_written`, `tools_used`, `approach`, `blockers`. When inactive, set it to empty string.
    - [x] Append `{{traceInstructions}}` to the end of each default template in `src/domain/defaults.ts` (`DEFAULT_TASK_TEMPLATE`, `DEFAULT_VERIFY_TEMPLATE`, `DEFAULT_REPAIR_TEMPLATE`, `DEFAULT_PLAN_TEMPLATE`). It renders empty when tracing is off.
  - Event types
    - [x] Add `agent.signals`, `agent.thinking`, and `agent.tool_usage` event types to the trace event discriminated union in `src/domain/trace.ts` with payload interfaces for each (confidence/files/tools/approach/blockers for signals, block count/total chars for thinking, tool list for tool_usage). Export factory functions.
  - Rich event emission
    - [x] After each phase completes in `src/application/run-task.ts`, run `parseWorkerOutput()` on stdout. If agent signals are present, emit `agent.signals` trace event. If thinking blocks are found, emit `agent.thinking` event with block count and total character count. If `tools_used` is present, emit `agent.tool_usage` event.
  - Tests
    - [x] Create `__tests__/domain/trace-parser.test.ts` — test valid block extraction, missing block returns null, malformed block handling, multiple blocks picks the first, block with extra whitespace.
    - [x] Create `__tests__/domain/worker-output-parser.test.ts` — test thinking block extraction, rundown-trace block parsing, combined output, empty stdout, stdout with no trace-relevant content.
    - [x] Add test in `__tests__/domain/template.test.ts` — verify `{{traceInstructions}}` renders empty string when variable is empty, renders content when set.
- Phase 3: LLM Enrichment Pass
  - Template and types
    - [x] Add `analysis.summary` event type to the trace event discriminated union in `src/domain/trace.ts` with fields: `task_complexity`, `execution_quality`, `direction_changes`, `modules_touched`, `wasted_effort_pct`, `key_decisions`, `risk_flags`, `improvement_suggestions`, `skill_gaps`, `thinking_quality`, `uncertainty_moments`.
    - [x] Add `DEFAULT_TRACE_TEMPLATE` to `src/domain/defaults.ts` — a template that receives full run context (phase outputs, timings, agent signals, thinking blocks) and instructs the LLM to produce a structured `analysis.summary` JSON block.
    - [x] Add `.rundown/trace.md` loading to `src/infrastructure/templates-loader.ts` following the existing template loading pattern. Fall back to `DEFAULT_TRACE_TEMPLATE` when the file does not exist.
    - [x] Add `trace.md` generation to `src/application/init-project.ts` so `rundown init` creates it alongside the other templates.
  - Enrichment execution
    - [x] Implement trace enrichment as a final phase in `src/application/run-task.ts`: after the main run completes (success or failure) and `--trace` is active, gather all phase metadata and stdout/stderr, render the trace template with this context, execute the worker once more, parse the structured output into an `analysis.summary` trace event, and append it to the trace file.
  - CLI extension
    - [x] Add `--trace-only` flag to the `run` command in `src/presentation/cli.ts`. When set, skip task execution entirely and run only the trace enrichment pass against the most recent artifact run. Reuse the existing artifact loading pattern from `reverify`.
  - Tests
    - [x] Add unit test for `analysis.summary` event type construction in `__tests__/domain/trace.test.ts`.
    - [x] Add integration test — run with `--trace`, verify `trace.jsonl` contains an `analysis.summary` event as the last event before `run.completed`.
- Phase 4: Rich Deterministic Metrics
  - [x] Emit `prompt.metrics` trace event per phase in `src/application/run-task.ts`: `char_count` (prompt length), `estimated_tokens` (chars / 4), `context_ratio` (context chars / total chars), `template_name`. Add event type to `src/domain/trace.ts`.
  - [x] Emit `timing.waterfall` trace event at run end in `src/application/run-task.ts`: array of per-phase `{ phase, sequence, started_at, completed_at, duration_ms }`, plus `idle_time_ms`, `total_wall_time_ms`, `total_worker_time_ms`. Add event type to `src/domain/trace.ts`.
  - [x] Emit `verification.efficiency` trace event in `src/application/verify-repair-loop.ts`: `first_pass_success`, `total_verify_attempts`, `total_repair_attempts`, `verification_to_execution_ratio`, `cumulative_failure_reasons`. Add event type to `src/domain/trace.ts`.
  - [x] Emit `output.volume` trace event per phase: `stdout_bytes`, `stderr_bytes`, `stdout_lines`, `stderr_lines`. Add event type to `src/domain/trace.ts`.
  - [x] Emit `task.context` trace event in `src/application/run-task.ts`: `source_files_scanned`, `total_unchecked_tasks`, `task_position_in_file`, `document_context_lines`, `has_subtasks`, `is_inline_cli`, `is_verify_only`. Add event type to `src/domain/trace.ts`.
  - Tests
    - [x] Add unit tests for all new metric event types in `__tests__/domain/trace.test.ts`.
    - [x] Add integration test — run with `--trace`, verify `trace.jsonl` contains `prompt.metrics`, `timing.waterfall`, and `verification.efficiency` events with expected numeric fields.