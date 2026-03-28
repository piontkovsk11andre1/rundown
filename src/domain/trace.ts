export const TRACE_SCHEMA_VERSION = 1 as const;

export type TraceSchemaVersion = typeof TRACE_SCHEMA_VERSION;

export type TraceEventType =
  | "run.started"
  | "task.context"
  | "phase.started"
  | "phase.completed"
  | "output.volume"
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

export type TracePhase = "execute" | "verify" | "repair" | "plan";

export type TraceRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "detached"
  | "execution-failed"
  | "verification-failed"
  | "reverify-completed"
  | "reverify-failed"
  | "reverted"
  | "revert-failed"
  | "metadata-missing";

export interface TraceEventBase<TEventType extends TraceEventType, TPayload> {
  schema_version: TraceSchemaVersion;
  timestamp: string;
  run_id: string;
  event_type: TEventType;
  payload: TPayload;
}

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

export interface PhaseStartedPayload {
  phase: TracePhase;
  sequence: number;
  command: string[];
}

export interface TaskContextPayload {
  source_files_scanned: number;
  total_unchecked_tasks: number;
  task_position_in_file: number;
  document_context_lines: number;
  has_subtasks: boolean;
  is_inline_cli: boolean;
  is_verify_only: boolean;
}

export interface PhaseCompletedPayload {
  phase: TracePhase;
  sequence: number;
  exit_code: number | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  output_captured: boolean;
}

export interface PromptMetricsPayload {
  char_count: number;
  estimated_tokens: number;
  context_ratio: number;
  template_name: string;
}

export interface OutputVolumePayload {
  phase: TracePhase;
  sequence: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_lines: number;
  stderr_lines: number;
}

export interface TimingWaterfallPhase {
  phase: TracePhase;
  sequence: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

export interface TimingWaterfallPayload {
  phases: TimingWaterfallPhase[];
  idle_time_ms: number;
  total_wall_time_ms: number;
  total_worker_time_ms: number;
}

export interface AgentSignalsPayload {
  confidence: number | null;
  files_read: string[];
  files_written: string[];
  tools_used: string[];
  approach: string | null;
  blockers: string | null;
}

export interface AgentThinkingPayload {
  thinking_blocks_count: number;
  total_thinking_chars: number;
}

export interface AgentToolUsagePayload {
  tools: string[];
}

export type TaskComplexity = "low" | "medium" | "high" | "critical";

export type ExecutionQuality =
  | "clean"
  | "minor_issues"
  | "significant_issues"
  | "failed";

export type ThinkingQuality = "clear" | "scattered" | "circular";

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

export type VerificationOutcome = "pass" | "fail";

export interface VerificationResultPayload {
  outcome: VerificationOutcome;
  failure_reason: string | null;
  attempt_number: number;
}

export interface VerificationEfficiencyPayload {
  first_pass_success: boolean;
  total_verify_attempts: number;
  total_repair_attempts: number;
  verification_to_execution_ratio: number | null;
  cumulative_failure_reasons: string[];
}

export interface RepairAttemptPayload {
  attempt_number: number;
  max_attempts: number;
  previous_failure: string | null;
}

export interface RepairOutcomePayload {
  final_valid: boolean;
  total_attempts: number;
}

export interface TaskCompletedPayload {
  task_text: string;
  task_file: string;
  task_line: number;
  total_duration_ms: number;
  phases_count: number;
}

export interface TaskFailedPayload {
  task_text: string;
  reason: string;
  exit_code: number | null;
  final_status: TraceRunStatus;
}

export interface RunCompletedPayload {
  status: TraceRunStatus;
  total_duration_ms: number;
  total_phases: number;
}

export type RunStartedEvent = TraceEventBase<"run.started", RunStartedPayload>;
export type TaskContextEvent = TraceEventBase<"task.context", TaskContextPayload>;
export type PhaseStartedEvent = TraceEventBase<"phase.started", PhaseStartedPayload>;
export type PhaseCompletedEvent = TraceEventBase<"phase.completed", PhaseCompletedPayload>;
export type OutputVolumeEvent = TraceEventBase<"output.volume", OutputVolumePayload>;
export type PromptMetricsEvent = TraceEventBase<"prompt.metrics", PromptMetricsPayload>;
export type TimingWaterfallEvent = TraceEventBase<"timing.waterfall", TimingWaterfallPayload>;
export type AgentSignalsEvent = TraceEventBase<"agent.signals", AgentSignalsPayload>;
export type AgentThinkingEvent = TraceEventBase<"agent.thinking", AgentThinkingPayload>;
export type AgentToolUsageEvent = TraceEventBase<"agent.tool_usage", AgentToolUsagePayload>;
export type AnalysisSummaryEvent = TraceEventBase<"analysis.summary", AnalysisSummaryPayload>;
export type VerificationResultEvent = TraceEventBase<"verification.result", VerificationResultPayload>;
export type VerificationEfficiencyEvent = TraceEventBase<"verification.efficiency", VerificationEfficiencyPayload>;
export type RepairAttemptEvent = TraceEventBase<"repair.attempt", RepairAttemptPayload>;
export type RepairOutcomeEvent = TraceEventBase<"repair.outcome", RepairOutcomePayload>;
export type TaskCompletedEvent = TraceEventBase<"task.completed", TaskCompletedPayload>;
export type TaskFailedEvent = TraceEventBase<"task.failed", TaskFailedPayload>;
export type RunCompletedEvent = TraceEventBase<"run.completed", RunCompletedPayload>;

export type TraceEvent =
  | RunStartedEvent
  | TaskContextEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | OutputVolumeEvent
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

interface CreateTraceEventInput<TEventType extends TraceEventType, TPayload> {
  timestamp: string;
  run_id: string;
  payload: TPayload;
  event_type: TEventType;
}

function createTraceEvent<TEventType extends TraceEventType, TPayload>(
  input: CreateTraceEventInput<TEventType, TPayload>,
): TraceEventBase<TEventType, TPayload> {
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    timestamp: input.timestamp,
    run_id: input.run_id,
    event_type: input.event_type,
    payload: input.payload,
  };
}

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
