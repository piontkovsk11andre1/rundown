import { describe, expect, it, vi } from "vitest";

const {
  resolveSourcesMock,
  selectNextTaskMock,
  selectTaskByLocationMock,
  runWorkerMock,
  executeInlineCliMock,
  validateMock,
  correctMock,
} = vi.hoisted(() => ({
  resolveSourcesMock: vi.fn(),
  selectNextTaskMock: vi.fn(),
  selectTaskByLocationMock: vi.fn(),
  runWorkerMock: vi.fn(),
  executeInlineCliMock: vi.fn(),
  validateMock: vi.fn(),
  correctMock: vi.fn(),
}));

vi.mock("../../../src/infrastructure/sources.js", () => ({
  resolveSources: resolveSourcesMock,
}));

vi.mock("../../../src/infrastructure/selector.js", () => ({
  selectNextTask: selectNextTaskMock,
  selectTaskByLocation: selectTaskByLocationMock,
}));

vi.mock("../../../src/infrastructure/runner.js", () => ({
  runWorker: runWorkerMock,
}));

vi.mock("../../../src/infrastructure/inline-cli.js", () => ({
  executeInlineCli: executeInlineCliMock,
}));

vi.mock("../../../src/infrastructure/validation.js", () => ({
  validate: validateMock,
}));

vi.mock("../../../src/infrastructure/correction.js", () => ({
  correct: correctMock,
}));

import { createSourceResolverAdapter } from "../../../src/infrastructure/adapters/source-resolver-adapter.js";
import { createTaskSelectorAdapter } from "../../../src/infrastructure/adapters/task-selector-adapter.js";
import { createWorkerExecutorAdapter } from "../../../src/infrastructure/adapters/worker-executor-adapter.js";
import { createTaskValidationAdapter } from "../../../src/infrastructure/adapters/task-validation-adapter.js";
import { createTaskCorrectionAdapter } from "../../../src/infrastructure/adapters/task-correction-adapter.js";
import { createWorkingDirectoryAdapter } from "../../../src/infrastructure/adapters/working-directory-adapter.js";

describe("infrastructure adapters", () => {
  it("source resolver adapter delegates to resolveSources", async () => {
    resolveSourcesMock.mockResolvedValue(["/tmp/tasks.md"]);

    const adapter = createSourceResolverAdapter();
    const result = await adapter.resolveSources("tasks.md");

    expect(resolveSourcesMock).toHaveBeenCalledTimes(1);
    expect(resolveSourcesMock).toHaveBeenCalledWith("tasks.md");
    expect(result).toEqual(["/tmp/tasks.md"]);
  });

  it("task selector adapter delegates to selector functions", () => {
    const nextSelection = {
      task: { text: "Task A" },
      source: "tasks.md",
      contextBefore: "",
    };
    const locationSelection = {
      task: { text: "Task B" },
      source: "tasks.md",
      contextBefore: "",
    };
    selectNextTaskMock.mockReturnValue(nextSelection);
    selectTaskByLocationMock.mockReturnValue(locationSelection);

    const adapter = createTaskSelectorAdapter();
    const nextResult = adapter.selectNextTask(["tasks.md"], "none");
    const locationResult = adapter.selectTaskByLocation("tasks.md", 12);

    expect(selectNextTaskMock).toHaveBeenCalledTimes(1);
    expect(selectNextTaskMock).toHaveBeenCalledWith(["tasks.md"], "none");
    expect(selectTaskByLocationMock).toHaveBeenCalledTimes(1);
    expect(selectTaskByLocationMock).toHaveBeenCalledWith("tasks.md", 12);
    expect(nextResult).toBe(nextSelection);
    expect(locationResult).toBe(locationSelection);
  });

  it("worker executor adapter maps runWorker options", async () => {
    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const adapter = createWorkerExecutorAdapter();
    const artifactContext = { runId: "run-1" };
    const result = await adapter.runWorker({
      command: ["worker", "run"],
      prompt: "prompt",
      mode: "wait",
      transport: "file",
      cwd: "/repo",
      artifactContext,
      artifactPhase: "execute",
      artifactExtra: { stage: "test" },
    });

    expect(runWorkerMock).toHaveBeenCalledTimes(1);
    expect(runWorkerMock).toHaveBeenCalledWith({
      command: ["worker", "run"],
      prompt: "prompt",
      mode: "wait",
      transport: "file",
      cwd: "/repo",
      artifactContext,
      artifactPhase: "execute",
      artifactExtra: { stage: "test" },
    });
    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
  });

  it("worker executor adapter maps executeInlineCli options", async () => {
    executeInlineCliMock.mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "" });

    const adapter = createWorkerExecutorAdapter();
    const artifactContext = { runId: "run-2" };
    const result = await adapter.executeInlineCli("npm test", "/repo", {
      artifactContext,
      keepArtifacts: true,
      artifactExtra: { taskType: "inline-cli" },
    });

    expect(executeInlineCliMock).toHaveBeenCalledTimes(1);
    expect(executeInlineCliMock).toHaveBeenCalledWith("npm test", "/repo", {
      artifactContext,
      keepArtifacts: true,
      artifactExtra: { taskType: "inline-cli" },
    });
    expect(result).toEqual({ exitCode: 0, stdout: "done", stderr: "" });
  });

  it("task validation adapter delegates to validate", async () => {
    validateMock.mockResolvedValue(true);

    const adapter = createTaskValidationAdapter();
    const task = {
      text: "Task",
      checked: false,
      index: 1,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 0,
      file: "tasks.md",
      isInlineCli: false,
      depth: 0,
    };
    const templateVars = { owner: "cli" };
    const artifactContext = { runId: "run-3" };
    const result = await adapter.validate({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      template: "{{task}}",
      command: ["worker", "run"],
      mode: "wait",
      transport: "arg",
      cwd: "/repo",
      templateVars,
      artifactContext,
    });

    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock).toHaveBeenCalledWith({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      template: "{{task}}",
      command: ["worker", "run"],
      mode: "wait",
      transport: "arg",
      cwd: "/repo",
      templateVars,
      artifactContext,
    });
    expect(result).toBe(true);
  });

  it("task correction adapter delegates to correct", async () => {
    correctMock.mockResolvedValue({ valid: true, attempts: 1 });

    const adapter = createTaskCorrectionAdapter();
    const task = {
      text: "Task",
      checked: false,
      index: 1,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 0,
      file: "tasks.md",
      isInlineCli: false,
      depth: 0,
    };
    const templateVars = { owner: "cli" };
    const artifactContext = { runId: "run-4" };
    const result = await adapter.correct({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      correctTemplate: "repair",
      validateTemplate: "verify",
      command: ["worker", "run"],
      maxRetries: 2,
      mode: "wait",
      transport: "file",
      cwd: "/repo",
      templateVars,
      artifactContext,
    });

    expect(correctMock).toHaveBeenCalledTimes(1);
    expect(correctMock).toHaveBeenCalledWith({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      correctTemplate: "repair",
      validateTemplate: "verify",
      command: ["worker", "run"],
      maxRetries: 2,
      mode: "wait",
      transport: "file",
      cwd: "/repo",
      templateVars,
      artifactContext,
    });
    expect(result).toEqual({ valid: true, attempts: 1 });
  });

  it("working directory adapter returns process cwd", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace");

    const adapter = createWorkingDirectoryAdapter();

    expect(adapter.cwd()).toBe("/workspace");
    expect(cwdSpy).toHaveBeenCalledTimes(1);

    cwdSpy.mockRestore();
  });
});
