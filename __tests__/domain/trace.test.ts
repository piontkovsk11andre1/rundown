import { describe, expect, it } from "vitest";
import {
  TRACE_SCHEMA_VERSION,
  createAnalysisSummaryEvent,
  createDiscussionCompletedEvent,
  createDiscussionStartedEvent,
  createAgentSignalsEvent,
  createAgentThinkingEvent,
  createAgentToolUsageEvent,
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPromptMetricsEvent,
  createPhaseStartedEvent,
  createRepairAttemptEvent,
  createRepairOutcomeEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  createTaskContextEvent,
  createTimingWaterfallEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createVerificationEfficiencyEvent,
  createVerificationResultEvent,
} from "../../src/domain/trace.js";

const ISO_8601_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectCommonTraceFields(event: {
  schema_version: number;
  timestamp: string;
  run_id: string;
  event_type: string;
}): void {
  expect(event.schema_version).toBe(TRACE_SCHEMA_VERSION);
  expect(event.run_id).toBe("run-123");
  expect(event.timestamp).toMatch(ISO_8601_UTC_TIMESTAMP);
  expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
}

describe("trace event factory functions", () => {
  const timestamp = "2026-03-25T19:20:40.486Z";

  it("creates run.started event with schema version and required payload fields", () => {
    const event = createRunStartedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        command: "run",
        source: "TODO.md",
        worker: ["opencode", "run"],
        mode: "default",
        transport: "stdin",
        task_text: "Create trace tests",
        task_file: "TODO.md",
        task_line: 247,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("run.started");
    expect(event.payload).toEqual({
      command: "run",
      source: "TODO.md",
      worker: ["opencode", "run"],
      mode: "default",
      transport: "stdin",
      task_text: "Create trace tests",
      task_file: "TODO.md",
      task_line: 247,
    });
  });

  it("creates discussion.started event with schema version and required payload fields", () => {
    const event = createDiscussionStartedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        task_text: "Refine rollout scope",
        task_file: "TODO.md",
        task_line: 80,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("discussion.started");
    expect(event.payload).toEqual({
      task_text: "Refine rollout scope",
      task_file: "TODO.md",
      task_line: 80,
    });
  });

  it("creates discussion.completed event with schema version and required payload fields", () => {
    const event = createDiscussionCompletedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        task_text: "Refine rollout scope",
        task_file: "TODO.md",
        task_line: 80,
        duration_ms: 1250,
        exit_code: 0,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("discussion.completed");
    expect(event.payload).toEqual({
      task_text: "Refine rollout scope",
      task_file: "TODO.md",
      task_line: 80,
      duration_ms: 1250,
      exit_code: 0,
    });
  });

  it("creates phase.started event with schema version and required payload fields", () => {
    const event = createPhaseStartedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        phase: "execute",
        sequence: 1,
        command: ["opencode", "run"],
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("phase.started");
    expect(event.payload).toEqual({
      phase: "execute",
      sequence: 1,
      command: ["opencode", "run"],
    });
  });

  it("creates task.context event with schema version and required payload fields", () => {
    const event = createTaskContextEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        source_files_scanned: 4,
        total_unchecked_tasks: 11,
        task_position_in_file: 3,
        document_context_lines: 40,
        has_subtasks: true,
        is_inline_cli: false,
        is_verify_only: true,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("task.context");
    expect(event.payload).toEqual({
      source_files_scanned: 4,
      total_unchecked_tasks: 11,
      task_position_in_file: 3,
      document_context_lines: 40,
      has_subtasks: true,
      is_inline_cli: false,
      is_verify_only: true,
    });
  });

  it("creates phase.completed event with schema version and required payload fields", () => {
    const event = createPhaseCompletedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        phase: "verify",
        sequence: 2,
        exit_code: 0,
        duration_ms: 250,
        stdout_bytes: 1024,
        stderr_bytes: 0,
        output_captured: true,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("phase.completed");
    expect(event.payload).toEqual({
      phase: "verify",
      sequence: 2,
      exit_code: 0,
      duration_ms: 250,
      stdout_bytes: 1024,
      stderr_bytes: 0,
      output_captured: true,
    });
  });

  it("creates prompt.metrics event with schema version and required payload fields", () => {
    const event = createPromptMetricsEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        char_count: 2048,
        estimated_tokens: 512,
        context_ratio: 0.35,
        template_name: "execute.md",
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("prompt.metrics");
    expect(event.payload).toEqual({
      char_count: 2048,
      estimated_tokens: 512,
      context_ratio: 0.35,
      template_name: "execute.md",
    });
  });

  it("creates output.volume event with schema version and required payload fields", () => {
    const event = createOutputVolumeEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        phase: "execute",
        sequence: 1,
        stdout_bytes: 128,
        stderr_bytes: 64,
        stdout_lines: 7,
        stderr_lines: 2,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("output.volume");
    expect(event.payload).toEqual({
      phase: "execute",
      sequence: 1,
      stdout_bytes: 128,
      stderr_bytes: 64,
      stdout_lines: 7,
      stderr_lines: 2,
    });
  });

  it("creates timing.waterfall event with schema version and required payload fields", () => {
    const event = createTimingWaterfallEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        phases: [
          {
            phase: "execute",
            sequence: 1,
            started_at: "2026-03-25T19:20:40.486Z",
            completed_at: "2026-03-25T19:20:41.486Z",
            duration_ms: 1000,
          },
          {
            phase: "verify",
            sequence: 2,
            started_at: "2026-03-25T19:20:42.486Z",
            completed_at: "2026-03-25T19:20:42.786Z",
            duration_ms: 300,
          },
        ],
        idle_time_ms: 1000,
        total_wall_time_ms: 2300,
        total_worker_time_ms: 1300,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("timing.waterfall");
    expect(event.payload).toEqual({
      phases: [
        {
          phase: "execute",
          sequence: 1,
          started_at: "2026-03-25T19:20:40.486Z",
          completed_at: "2026-03-25T19:20:41.486Z",
          duration_ms: 1000,
        },
        {
          phase: "verify",
          sequence: 2,
          started_at: "2026-03-25T19:20:42.486Z",
          completed_at: "2026-03-25T19:20:42.786Z",
          duration_ms: 300,
        },
      ],
      idle_time_ms: 1000,
      total_wall_time_ms: 2300,
      total_worker_time_ms: 1300,
    });
  });

  it("creates agent.signals event with schema version and required payload fields", () => {
    const event = createAgentSignalsEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        confidence: 88,
        files_read: ["src/domain/trace.ts", "src/application/run-task.ts"],
        files_written: ["src/domain/trace.ts"],
        tools_used: ["Read", "apply_patch"],
        approach: "Extend trace union and add event factories",
        blockers: "none",
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("agent.signals");
    expect(event.payload).toEqual({
      confidence: 88,
      files_read: ["src/domain/trace.ts", "src/application/run-task.ts"],
      files_written: ["src/domain/trace.ts"],
      tools_used: ["Read", "apply_patch"],
      approach: "Extend trace union and add event factories",
      blockers: "none",
    });
  });

  it("creates agent.thinking event with schema version and required payload fields", () => {
    const event = createAgentThinkingEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        thinking_blocks_count: 3,
        total_thinking_chars: 482,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("agent.thinking");
    expect(event.payload).toEqual({
      thinking_blocks_count: 3,
      total_thinking_chars: 482,
    });
  });

  it("creates agent.tool_usage event with schema version and required payload fields", () => {
    const event = createAgentToolUsageEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        tools: ["Read", "Grep", "apply_patch"],
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("agent.tool_usage");
    expect(event.payload).toEqual({
      tools: ["Read", "Grep", "apply_patch"],
    });
  });

  it("creates analysis.summary event with schema version and required payload fields", () => {
    const event = createAnalysisSummaryEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        task_complexity: "high",
        execution_quality: "minor_issues",
        direction_changes: 2,
        modules_touched: ["src/domain", "src/application"],
        wasted_effort_pct: 15,
        key_decisions: ["use discriminated union", "add typed factory"],
        risk_flags: ["schema drift"],
        improvement_suggestions: ["add contract tests"],
        skill_gaps: ["cross-module trace consistency"],
        thinking_quality: "clear",
        uncertainty_moments: 1,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("analysis.summary");
    expect(event.payload).toEqual({
      task_complexity: "high",
      execution_quality: "minor_issues",
      direction_changes: 2,
      modules_touched: ["src/domain", "src/application"],
      wasted_effort_pct: 15,
      key_decisions: ["use discriminated union", "add typed factory"],
      risk_flags: ["schema drift"],
      improvement_suggestions: ["add contract tests"],
      skill_gaps: ["cross-module trace consistency"],
      thinking_quality: "clear",
      uncertainty_moments: 1,
    });
  });

  it("creates verification.result event with schema version and required payload fields", () => {
    const event = createVerificationResultEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        outcome: "pass",
        failure_reason: null,
        attempt_number: 1,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("verification.result");
    expect(event.payload).toEqual({
      outcome: "pass",
      failure_reason: null,
      attempt_number: 1,
    });
  });

  it("creates verification.efficiency event with schema version and required payload fields", () => {
    const event = createVerificationEfficiencyEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        first_pass_success: false,
        total_verify_attempts: 3,
        total_repair_attempts: 2,
        verification_to_execution_ratio: 0.6,
        cumulative_failure_reasons: ["missing test", "failing assertion"],
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("verification.efficiency");
    expect(event.payload).toEqual({
      first_pass_success: false,
      total_verify_attempts: 3,
      total_repair_attempts: 2,
      verification_to_execution_ratio: 0.6,
      cumulative_failure_reasons: ["missing test", "failing assertion"],
    });
  });

  it("creates repair.attempt event with schema version and required payload fields", () => {
    const event = createRepairAttemptEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        attempt_number: 1,
        max_attempts: 3,
        previous_failure: "Missing unit tests",
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("repair.attempt");
    expect(event.payload).toEqual({
      attempt_number: 1,
      max_attempts: 3,
      previous_failure: "Missing unit tests",
    });
  });

  it("creates repair.outcome event with schema version and required payload fields", () => {
    const event = createRepairOutcomeEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        final_valid: true,
        total_attempts: 1,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("repair.outcome");
    expect(event.payload).toEqual({
      final_valid: true,
      total_attempts: 1,
    });
  });

  it("creates task.completed event with schema version and required payload fields", () => {
    const event = createTaskCompletedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        task_text: "Create tests",
        task_file: "TODO.md",
        task_line: 247,
        total_duration_ms: 1500,
        phases_count: 3,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("task.completed");
    expect(event.payload).toEqual({
      task_text: "Create tests",
      task_file: "TODO.md",
      task_line: 247,
      total_duration_ms: 1500,
      phases_count: 3,
    });
  });

  it("creates task.failed event with schema version and required payload fields", () => {
    const event = createTaskFailedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        task_text: "Create tests",
        reason: "Verification failed",
        exit_code: 1,
        final_status: "verification-failed",
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("task.failed");
    expect(event.payload).toEqual({
      task_text: "Create tests",
      reason: "Verification failed",
      exit_code: 1,
      final_status: "verification-failed",
    });
  });

  it("creates run.completed event with schema version and required payload fields", () => {
    const event = createRunCompletedEvent({
      timestamp,
      run_id: "run-123",
      payload: {
        status: "completed",
        total_duration_ms: 1600,
        total_phases: 3,
      },
    });

    expectCommonTraceFields(event);
    expect(event.event_type).toBe("run.completed");
    expect(event.payload).toEqual({
      status: "completed",
      total_duration_ms: 1600,
      total_phases: 3,
    });
  });
});
