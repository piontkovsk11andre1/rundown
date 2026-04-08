import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import { createTraceRunSession } from "../../src/application/trace-run-session.js";

describe("trace-run-session", () => {
  it("emits run lifecycle events", () => {
    const write = vi.fn();
    const session = createTraceRunSession({
      getTraceWriter: () => ({ write, flush: vi.fn() }),
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: true,
    });

    const task: Task = {
      text: "build release",
      checked: false,
      index: 0,
      line: 2,
      column: 1,
      offsetStart: 0,
      offsetEnd: 13,
      file: "/workspace/tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };

    session.startRun({
      artifactContext: {
        runId: "run-1",
        rootDir: "/workspace/.rundown/runs/run-1",
        cwd: "/workspace",
        keepArtifacts: false,
        commandName: "run",
      },
      task,
      worker: ["opencode", "run"],
      metrics: {
        sourceFilesScanned: 1,
        totalUncheckedTasks: 3,
        taskPositionInFile: 1,
        hasSubtasks: false,
      },
      isVerifyOnly: false,
      contextBefore: "intro",
    });

    const phase = session.beginPhase("execute", ["opencode", "run"]);
    session.emitRoundStarted(1, 2);
    session.emitPromptMetrics("prompt", "context", "execute");
    session.completePhase(phase, 0, "stdout", "", true);
    session.emitRoundCompleted(1, 2);
    session.emitTaskOutcome("completed");
    session.emitDeferredEvents();
    session.emitRunCompleted("completed");

    expect(write.mock.calls.some((call) => call[0]?.event_type === "run.started")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "round.started")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "phase.started")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "prompt.metrics")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "phase.completed")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "round.completed")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "task.completed")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "run.completed")).toBe(true);
    expect(session.getRunId()).toBe("run-1");
    expect(session.hasActiveRun()).toBe(true);
  });

  it("collectStatistics aggregates all statistics field sources", () => {
    const write = vi.fn();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1_000) // startRun
      .mockReturnValueOnce(1_100) // begin execute
      .mockReturnValueOnce(2_100) // complete execute
      .mockReturnValueOnce(2_500) // begin verify
      .mockReturnValueOnce(3_000) // complete verify
      .mockReturnValueOnce(3_600) // begin repair
      .mockReturnValueOnce(4_200) // complete repair
      .mockReturnValueOnce(5_000); // collectStatistics

    const session = createTraceRunSession({
      getTraceWriter: () => ({ write, flush: vi.fn() }),
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: true,
    });

    const task: Task = {
      text: "build release",
      checked: false,
      index: 0,
      line: 2,
      column: 1,
      offsetStart: 0,
      offsetEnd: 13,
      file: "/workspace/tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };

    session.startRun({
      artifactContext: {
        runId: "run-1",
        rootDir: "/workspace/.rundown/runs/run-1",
        cwd: "/workspace",
        keepArtifacts: false,
        commandName: "run",
      },
      task,
      worker: ["opencode", "run"],
      metrics: {
        sourceFilesScanned: 1,
        totalUncheckedTasks: 3,
        taskPositionInFile: 1,
        hasSubtasks: false,
      },
      isVerifyOnly: false,
      contextBefore: "intro",
    });

    const executePhase = session.beginPhase("execute", ["opencode", "run"]);
    session.emitPromptMetrics("x".repeat(40), "ctx", "execute");
    session.emitPromptMetrics("y".repeat(100), "ctx", "verify");
    session.completePhase(executePhase, 0, "", "", true);

    const verifyPhase = session.beginPhase("verify", ["opencode", "run"]);
    session.completePhase(verifyPhase, 0, "", "", true);

    const repairPhase = session.beginPhase("repair", ["opencode", "run"]);
    session.completePhase(repairPhase, 0, "", "", true);

    session.setVerificationEfficiency(4, 2);

    const snapshot = session.collectStatistics();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fields).toEqual({
      total_time: 4000,
      execution_time: 1000,
      verify_time: 500,
      repair_time: 600,
      idle_time: 1000,
      tokens_estimated: 35,
      phases_count: 3,
      verify_attempts: 4,
      repair_attempts: 2,
    });

    nowSpy.mockRestore();
  });
});
