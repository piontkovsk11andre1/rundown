/**
 * Canonical schema definitions for trace events emitted during a rundown run.
 *
 * This module provides strongly typed payload contracts and event factories so
 * producers can emit consistent trace records across execution phases.
 */
export const TRACE_SCHEMA_VERSION = 1 as const;

/**
 * Current trace schema version literal used on all events.
 */
export type TraceSchemaVersion = typeof TRACE_SCHEMA_VERSION;

/**
 * Supported trace event identifiers emitted by the runtime.
 */
export type TraceEventType =
  | "run.started"
  | "round.started"
  | "round.completed"
  | "discussion.started"
  | "discussion.completed"
  | "discussion.finished.started"
  | "discussion.finished.completed"
  | "task.context"
  | "phase.started"
  | "phase.completed"
  | "output.volume"
  | "cli_block.executed"
  | "prompt.metrics"
  | "timing.waterfall"
  | "agent.signals"
  | "agent.thinking"
  | "agent.tool_usage"
  | "analysis.summary"
  | "verification.result"
  | "verification.efficiency"
  | "repair.attempt"
  | "repair.outcome"
  | "task.completed"
  | "task.failed"
  | "run.completed";

/**
 * Execution phases that can be recorded in trace output.
 */
export type TracePhase =
  | "execute"
  | "verify"
  | "repair"
  | "plan"
  | "discuss"
  | "rundown-delegate"
  | "pre-run-reset"
  | "post-run-reset";

/**
 * Aggregate run status values captured when a run finishes.
 */
export type TraceRunStatus =
  | "running"
  | "completed"
  | "discuss-completed"
  | "discuss-cancelled"
  | "discuss-finished-completed"
  | "discuss-finished-cancelled"
  | "failed"
  | "detached"
  | "execution-failed"
  | "verification-failed"
  | "reverify-completed"
  | "reverify-failed"
  | "reverted"
  | "revert-failed"
  | "metadata-missing";

/**
 * Base shape shared by all trace events.
 *
 * @template TEventType Specific event discriminator.
 * @template TPayload Payload type for the event.
 */
export interface TraceEventBase<TEventType extends TraceEventType, TPayload> {
  schema_version: TraceSchemaVersion;
  timestamp: string;
  run_id: string;
  event_type: TEventType;
  payload: TPayload;
}

/**
 * Payload for `run.started` events.
 */
export interface RunStartedPayload {
  command: string;
  source: string;
  worker: string[];
  mode: string;
  transport: string;
  task_text: string;
  task_file: string;
  task_line: number;
}

/**
 * Payload for `round.started` events.
 */
export interface RoundStartedPayload {
  current_round: number;
  total_rounds: number;
}

/**
 * Payload for `round.completed` events.
 */
export interface RoundCompletedPayload {
  current_round: number;
  total_rounds: number;
}

/**
 * Payload for `discussion.started` events.
 */
export interface DiscussionStartedPayload {
  task_text: string;
  task_file: string;
  task_line: number;
}

/**
 * Payload for `discussion.completed` events.
 */
export interface DiscussionCompletedPayload {
  task_text: string;
  task_file: string;
  task_line: number;
  duration_ms: number;
  exit_code: number | null;
}

/**
 * Payload for `discussion.finished.started` events.
 */
export interface DiscussionFinishedStartedPayload {
  task_text: string;
  task_file: string;
  task_line: number;
  target_run_id: string;
  target_run_status: TraceRunStatus;
}

/**
 * Payload for `discussion.finished.completed` events.
 */
export interface DiscussionFinishedCompletedPayload {
  task_text: string;
  task_file: string;
  task_line: number;
  target_run_id: string;
  target_run_status: TraceRunStatus;
  duration_ms: number;
  exit_code: number | null;
}

/**
 * Payload for `phase.started` events.
 */
export interface PhaseStartedPayload {
  phase: TracePhase;
  sequence: number;
  command: string[];
}

/**
 * Payload describing discovered task context before execution starts.
 */
export interface TaskContextPayload {
  source_files_scanned: number;
  total_unchecked_tasks: number;
  task_position_in_file: number;
  document_context_lines: number;
  has_subtasks: boolean;
  is_inline_cli: boolean;
  is_verify_only: boolean;
}

/**
 * Payload for `phase.completed` events.
 */
export interface PhaseCompletedPayload {
  phase: TracePhase;
  sequence: number;
  exit_code: number | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  output_captured: boolean;
}

/**
 * Payload reporting prompt-size and template metrics.
 */
export interface PromptMetricsPayload {
  char_count: number;
  estimated_tokens: number;
  context_ratio: number;
  template_name: string;
}

/**
 * Payload describing stdout/stderr volume for a completed phase.
 */
export interface OutputVolumePayload {
  phase: TracePhase;
  sequence: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_lines: number;
  stderr_lines: number;
}

/**
 * Payload for a single executed inline CLI command.
 */
export interface CliBlockExecutedPayload {
  command: string;
  exit_code: number | null;
  stdout_length: number;
  stderr_length: number;
  duration_ms: number;
}

/**
 * Timing details for one recorded phase in the waterfall timeline.
 */
export interface TimingWaterfallPhase {
  phase: TracePhase;
  sequence: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

/**
 * Payload summarizing phase timing and overall wall/worker durations.
 */
export interface TimingWaterfallPayload {
  phases: TimingWaterfallPhase[];
  idle_time_ms: number;
  total_wall_time_ms: number;
  total_worker_time_ms: number;
}

/**
 * Payload containing optional self-reported agent telemetry.
 */
export interface AgentSignalsPayload {
  confidence: number | null;
  files_read: string[];
  files_written: string[];
  tools_used: string[];
  approach: string | null;
  blockers: string | null;
}

/**
 * Payload summarizing internal reasoning block volume.
 */
export interface AgentThinkingPayload {
  thinking_blocks_count: number;
  total_thinking_chars: number;
}

/**
 * Payload listing tools observed during execution.
 */
export interface AgentToolUsagePayload {
  tools: string[];
}

/**
 * Classification levels used to report perceived task complexity.
 */
export type TaskComplexity = "low" | "medium" | "high" | "critical";

/**
 * Overall quality labels for execution outcome.
 */
export type ExecutionQuality =
  | "clean"
  | "minor_issues"
  | "significant_issues"
  | "failed";

/**
 * Labels describing the coherence of thinking output.
 */
export type ThinkingQuality = "clear" | "scattered" | "circular";

/**
 * Payload for `analysis.summary` events.
 */
export interface AnalysisSummaryPayload {
  task_complexity: TaskComplexity;
  execution_quality: ExecutionQuality;
  direction_changes: number;
  modules_touched: string[];
  wasted_effort_pct: number;
  key_decisions: string[];
  risk_flags: string[];
  improvement_suggestions: string[];
  skill_gaps: string[];
  thinking_quality: ThinkingQuality;
  uncertainty_moments: number;
}

/**
 * Binary outcome for a verification pass.
 */
export type VerificationOutcome = "pass" | "fail";

/**
 * Payload for `verification.result` events.
 */
export interface VerificationResultPayload {
  outcome: VerificationOutcome;
  failure_reason: string | null;
  attempt_number: number;
}

/**
 * Payload tracking verification/repair efficiency across attempts.
 */
export interface VerificationEfficiencyPayload {
  first_pass_success: boolean;
  total_verify_attempts: number;
  total_repair_attempts: number;
  verification_to_execution_ratio: number | null;
  cumulative_failure_reasons: string[];
}

/**
 * Payload emitted before a repair attempt starts.
 */
export interface RepairAttemptPayload {
  attempt_number: number;
  max_attempts: number;
  previous_failure: string | null;
}

/**
 * Payload emitted after repair attempts finish.
 */
export interface RepairOutcomePayload {
  final_valid: boolean;
  total_attempts: number;
}

/**
 * Payload for `task.completed` events.
 */
export interface TaskCompletedPayload {
  task_text: string;
  task_file: string;
  task_line: number;
  total_duration_ms: number;
  phases_count: number;
}

/**
 * Payload for `task.failed` events.
 */
export interface TaskFailedPayload {
  task_text: string;
  reason: string;
  exit_code: number | null;
  final_status: TraceRunStatus;
}

/**
 * Payload emitted when the run reaches a terminal status.
 */
export interface RunCompletedPayload {
  status: TraceRunStatus;
  total_duration_ms: number;
  total_phases: number;
}

/**
 * Strongly typed event shape for `run.started`.
 */
export type RunStartedEvent = TraceEventBase<"run.started", RunStartedPayload>;
/**
 * Strongly typed event shape for `round.started`.
 */
export type RoundStartedEvent = TraceEventBase<"round.started", RoundStartedPayload>;
/**
 * Strongly typed event shape for `round.completed`.
 */
export type RoundCompletedEvent = TraceEventBase<"round.completed", RoundCompletedPayload>;
/**
 * Strongly typed event shape for `discussion.started`.
 */
export type DiscussionStartedEvent = TraceEventBase<
  "discussion.started",
  DiscussionStartedPayload
>;
/**
 * Strongly typed event shape for `discussion.completed`.
 */
export type DiscussionCompletedEvent = TraceEventBase<
  "discussion.completed",
  DiscussionCompletedPayload
>;
/**
 * Strongly typed event shape for `discussion.finished.started`.
 */
export type DiscussionFinishedStartedEvent = TraceEventBase<
  "discussion.finished.started",
  DiscussionFinishedStartedPayload
>;
/**
 * Strongly typed event shape for `discussion.finished.completed`.
 */
export type DiscussionFinishedCompletedEvent = TraceEventBase<
  "discussion.finished.completed",
  DiscussionFinishedCompletedPayload
>;
/**
 * Strongly typed event shape for `task.context`.
 */
export type TaskContextEvent = TraceEventBase<"task.context", TaskContextPayload>;
/**
 * Strongly typed event shape for `phase.started`.
 */
export type PhaseStartedEvent = TraceEventBase<"phase.started", PhaseStartedPayload>;
/**
 * Strongly typed event shape for `phase.completed`.
 */
export type PhaseCompletedEvent = TraceEventBase<"phase.completed", PhaseCompletedPayload>;
/**
 * Strongly typed event shape for `output.volume`.
 */
export type OutputVolumeEvent = TraceEventBase<"output.volume", OutputVolumePayload>;
/**
 * Strongly typed event shape for `cli_block.executed`.
 */
export type CliBlockExecutedEvent = TraceEventBase<"cli_block.executed", CliBlockExecutedPayload>;
/**
 * Strongly typed event shape for `prompt.metrics`.
 */
export type PromptMetricsEvent = TraceEventBase<"prompt.metrics", PromptMetricsPayload>;
/**
 * Strongly typed event shape for `timing.waterfall`.
 */
export type TimingWaterfallEvent = TraceEventBase<"timing.waterfall", TimingWaterfallPayload>;
/**
 * Strongly typed event shape for `agent.signals`.
 */
export type AgentSignalsEvent = TraceEventBase<"agent.signals", AgentSignalsPayload>;
/**
 * Strongly typed event shape for `agent.thinking`.
 */
export type AgentThinkingEvent = TraceEventBase<"agent.thinking", AgentThinkingPayload>;
/**
 * Strongly typed event shape for `agent.tool_usage`.
 */
export type AgentToolUsageEvent = TraceEventBase<"agent.tool_usage", AgentToolUsagePayload>;
/**
 * Strongly typed event shape for `analysis.summary`.
 */
export type AnalysisSummaryEvent = TraceEventBase<"analysis.summary", AnalysisSummaryPayload>;
/**
 * Strongly typed event shape for `verification.result`.
 */
export type VerificationResultEvent = TraceEventBase<"verification.result", VerificationResultPayload>;
/**
 * Strongly typed event shape for `verification.efficiency`.
 */
export type VerificationEfficiencyEvent = TraceEventBase<"verification.efficiency", VerificationEfficiencyPayload>;
/**
 * Strongly typed event shape for `repair.attempt`.
 */
export type RepairAttemptEvent = TraceEventBase<"repair.attempt", RepairAttemptPayload>;
/**
 * Strongly typed event shape for `repair.outcome`.
 */
export type RepairOutcomeEvent = TraceEventBase<"repair.outcome", RepairOutcomePayload>;
/**
 * Strongly typed event shape for `task.completed`.
 */
export type TaskCompletedEvent = TraceEventBase<"task.completed", TaskCompletedPayload>;
/**
 * Strongly typed event shape for `task.failed`.
 */
export type TaskFailedEvent = TraceEventBase<"task.failed", TaskFailedPayload>;
/**
 * Strongly typed event shape for `run.completed`.
 */
export type RunCompletedEvent = TraceEventBase<"run.completed", RunCompletedPayload>;

/**
 * Discriminated union of every event record emitted by the trace subsystem.
 */
export type TraceEvent =
  | RunStartedEvent
  | RoundStartedEvent
  | RoundCompletedEvent
  | DiscussionStartedEvent
  | DiscussionCompletedEvent
  | DiscussionFinishedStartedEvent
  | DiscussionFinishedCompletedEvent
  | TaskContextEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | OutputVolumeEvent
  | CliBlockExecutedEvent
  | PromptMetricsEvent
  | TimingWaterfallEvent
  | AgentSignalsEvent
  | AgentThinkingEvent
  | AgentToolUsageEvent
  | AnalysisSummaryEvent
  | VerificationResultEvent
  | VerificationEfficiencyEvent
  | RepairAttemptEvent
  | RepairOutcomeEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | RunCompletedEvent;

/**
 * Shared constructor input for concrete trace event factory functions.
 *
 * @template TEventType Specific event discriminator.
 * @template TPayload Payload type for the event.
 */
interface CreateTraceEventInput<TEventType extends TraceEventType, TPayload> {
  timestamp: string;
  run_id: string;
  payload: TPayload;
  event_type: TEventType;
}

/**
 * Builds a trace event with shared metadata and payload fields.
 *
 * @template TEventType Specific event discriminator.
 * @template TPayload Payload type for the event.
 * @param input Event construction input values.
 * @returns Fully formed trace event object.
 */
function createTraceEvent<TEventType extends TraceEventType, TPayload>(
  input: CreateTraceEventInput<TEventType, TPayload>,
): TraceEventBase<TEventType, TPayload> {
  return {
    // Stamp all emitted events with the canonical schema version.
    schema_version: TRACE_SCHEMA_VERSION,
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: input.event_type,
    payload: input.payload,
  };
}

/**
 * Creates a `run.started` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `run.started` event.
 */
export function createRunStartedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: RunStartedPayload;
}): RunStartedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "run.started",
    payload: input.payload,
  });
}

/**
 * Creates a `round.started` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `round.started` event.
 */
export function createRoundStartedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: RoundStartedPayload;
}): RoundStartedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "round.started",
    payload: input.payload,
  });
}

/**
 * Creates a `round.completed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `round.completed` event.
 */
export function createRoundCompletedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: RoundCompletedPayload;
}): RoundCompletedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "round.completed",
    payload: input.payload,
  });
}

/**
 * Creates a `discussion.started` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `discussion.started` event.
 */
export function createDiscussionStartedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: DiscussionStartedPayload;
}): DiscussionStartedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "discussion.started",
    payload: input.payload,
  });
}

/**
 * Creates a `discussion.completed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `discussion.completed` event.
 */
export function createDiscussionCompletedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: DiscussionCompletedPayload;
}): DiscussionCompletedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "discussion.completed",
    payload: input.payload,
  });
}

/**
 * Creates a `discussion.finished.started` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `discussion.finished.started` event.
 */
export function createDiscussionFinishedStartedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: DiscussionFinishedStartedPayload;
}): DiscussionFinishedStartedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "discussion.finished.started",
    payload: input.payload,
  });
}

/**
 * Creates a `discussion.finished.completed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `discussion.finished.completed` event.
 */
export function createDiscussionFinishedCompletedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: DiscussionFinishedCompletedPayload;
}): DiscussionFinishedCompletedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "discussion.finished.completed",
    payload: input.payload,
  });
}

/**
 * Creates a `phase.started` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `phase.started` event.
 */
export function createPhaseStartedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: PhaseStartedPayload;
}): PhaseStartedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "phase.started",
    payload: input.payload,
  });
}

/**
 * Creates a `task.context` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `task.context` event.
 */
export function createTaskContextEvent(input: {
  timestamp: string;
  run_id: string;
  payload: TaskContextPayload;
}): TaskContextEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "task.context",
    payload: input.payload,
  });
}

/**
 * Creates a `phase.completed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `phase.completed` event.
 */
export function createPhaseCompletedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: PhaseCompletedPayload;
}): PhaseCompletedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "phase.completed",
    payload: input.payload,
  });
}

/**
 * Creates a `prompt.metrics` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `prompt.metrics` event.
 */
export function createPromptMetricsEvent(input: {
  timestamp: string;
  run_id: string;
  payload: PromptMetricsPayload;
}): PromptMetricsEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "prompt.metrics",
    payload: input.payload,
  });
}

/**
 * Creates an `output.volume` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `output.volume` event.
 */
export function createOutputVolumeEvent(input: {
  timestamp: string;
  run_id: string;
  payload: OutputVolumePayload;
}): OutputVolumeEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "output.volume",
    payload: input.payload,
  });
}

/**
 * Creates a `cli_block.executed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `cli_block.executed` event.
 */
export function createCliBlockExecutedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: CliBlockExecutedPayload;
}): CliBlockExecutedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "cli_block.executed",
    payload: input.payload,
  });
}

/**
 * Creates a `timing.waterfall` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `timing.waterfall` event.
 */
export function createTimingWaterfallEvent(input: {
  timestamp: string;
  run_id: string;
  payload: TimingWaterfallPayload;
}): TimingWaterfallEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "timing.waterfall",
    payload: input.payload,
  });
}

/**
 * Creates an `agent.signals` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `agent.signals` event.
 */
export function createAgentSignalsEvent(input: {
  timestamp: string;
  run_id: string;
  payload: AgentSignalsPayload;
}): AgentSignalsEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "agent.signals",
    payload: input.payload,
  });
}

/**
 * Creates an `agent.thinking` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `agent.thinking` event.
 */
export function createAgentThinkingEvent(input: {
  timestamp: string;
  run_id: string;
  payload: AgentThinkingPayload;
}): AgentThinkingEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "agent.thinking",
    payload: input.payload,
  });
}

/**
 * Creates an `agent.tool_usage` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `agent.tool_usage` event.
 */
export function createAgentToolUsageEvent(input: {
  timestamp: string;
  run_id: string;
  payload: AgentToolUsagePayload;
}): AgentToolUsageEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "agent.tool_usage",
    payload: input.payload,
  });
}

/**
 * Creates an `analysis.summary` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `analysis.summary` event.
 */
export function createAnalysisSummaryEvent(input: {
  timestamp: string;
  run_id: string;
  payload: AnalysisSummaryPayload;
}): AnalysisSummaryEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "analysis.summary",
    payload: input.payload,
  });
}

/**
 * Creates a `verification.result` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `verification.result` event.
 */
export function createVerificationResultEvent(input: {
  timestamp: string;
  run_id: string;
  payload: VerificationResultPayload;
}): VerificationResultEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "verification.result",
    payload: input.payload,
  });
}

/**
 * Creates a `verification.efficiency` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `verification.efficiency` event.
 */
export function createVerificationEfficiencyEvent(input: {
  timestamp: string;
  run_id: string;
  payload: VerificationEfficiencyPayload;
}): VerificationEfficiencyEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "verification.efficiency",
    payload: input.payload,
  });
}

/**
 * Creates a `repair.attempt` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `repair.attempt` event.
 */
export function createRepairAttemptEvent(input: {
  timestamp: string;
  run_id: string;
  payload: RepairAttemptPayload;
}): RepairAttemptEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "repair.attempt",
    payload: input.payload,
  });
}

/**
 * Creates a `repair.outcome` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `repair.outcome` event.
 */
export function createRepairOutcomeEvent(input: {
  timestamp: string;
  run_id: string;
  payload: RepairOutcomePayload;
}): RepairOutcomeEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "repair.outcome",
    payload: input.payload,
  });
}

/**
 * Creates a `task.completed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `task.completed` event.
 */
export function createTaskCompletedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: TaskCompletedPayload;
}): TaskCompletedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "task.completed",
    payload: input.payload,
  });
}

/**
 * Creates a `task.failed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `task.failed` event.
 */
export function createTaskFailedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: TaskFailedPayload;
}): TaskFailedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "task.failed",
    payload: input.payload,
  });
}

/**
 * Creates a `run.completed` trace event.
 *
 * @param input Required metadata and payload for the event.
 * @returns Typed `run.completed` event.
 */
export function createRunCompletedEvent(input: {
  timestamp: string;
  run_id: string;
  payload: RunCompletedPayload;
}): RunCompletedEvent {
  return createTraceEvent({
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: "run.completed",
    payload: input.payload,
  });
}
