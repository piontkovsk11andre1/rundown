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
      isRundownTask: false,
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
    session.emitPromptMetrics("prompt", "context", "execute");
    session.completePhase(phase, 0, "stdout", "", true);
    session.emitTaskOutcome("completed");
    session.emitDeferredEvents();
    session.emitRunCompleted("completed");

    expect(write.mock.calls.some((call) => call[0]?.event_type === "run.started")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "phase.started")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "prompt.metrics")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "phase.completed")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "task.completed")).toBe(true);
    expect(write.mock.calls.some((call) => call[0]?.event_type === "run.completed")).toBe(true);
    expect(session.getRunId()).toBe("run-1");
    expect(session.hasActiveRun()).toBe(true);
  });
});
