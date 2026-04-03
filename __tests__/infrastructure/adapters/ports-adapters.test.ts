import { describe, expect, it, vi } from "vitest";

const {
  resolveSourcesMock,
  selectNextTaskMock,
  selectTaskByLocationMock,
  runWorkerMock,
  executeInlineCliMock,
  executeRundownTaskMock,
  verifyMock,
  repairMock,
} = vi.hoisted(() => ({
  resolveSourcesMock: vi.fn(),
  selectNextTaskMock: vi.fn(),
  selectTaskByLocationMock: vi.fn(),
  runWorkerMock: vi.fn(),
  executeInlineCliMock: vi.fn(),
  executeRundownTaskMock: vi.fn(),
  verifyMock: vi.fn(),
  repairMock: vi.fn(),
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

vi.mock("../../../src/infrastructure/inline-rundown.js", () => ({
  executeRundownTask: executeRundownTaskMock,
}));

vi.mock("../../../src/infrastructure/verification.js", () => ({
  verify: verifyMock,
}));

vi.mock("../../../src/infrastructure/repair.js", () => ({
  repair: repairMock,
}));

import { createSourceResolverAdapter } from "../../../src/infrastructure/adapters/source-resolver-adapter.js";
import { createTaskSelectorAdapter } from "../../../src/infrastructure/adapters/task-selector-adapter.js";
import { createWorkerExecutorAdapter } from "../../../src/infrastructure/adapters/worker-executor-adapter.js";
import { createTaskVerificationAdapter } from "../../../src/infrastructure/adapters/task-verification-adapter.js";
import { createTaskRepairAdapter } from "../../../src/infrastructure/adapters/task-repair-adapter.js";
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

  it("worker executor adapter maps executeRundownTask options", async () => {
    executeRundownTaskMock.mockResolvedValue({ exitCode: 0, stdout: "delegated", stderr: "" });

    const adapter = createWorkerExecutorAdapter();
    const artifactContext = { runId: "run-2b" };
    const result = await adapter.executeRundownTask("run", ["Child.md", "--verify"], "/repo", {
      artifactContext,
      keepArtifacts: true,
      artifactExtra: { taskType: "rundown" },
      rundownCommand: ["node", "dist/cli.js"],
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "arg",
      parentKeepArtifacts: true,
      parentShowAgentOutput: true,
      parentIgnoreCliBlock: true,
      parentVerify: false,
      parentNoRepair: true,
      parentRepairAttempts: 2,
    });

    expect(executeRundownTaskMock).toHaveBeenCalledTimes(1);
    expect(executeRundownTaskMock).toHaveBeenCalledWith("run", ["Child.md", "--verify"], "/repo", {
      artifactContext,
      keepArtifacts: true,
      artifactExtra: { taskType: "rundown" },
      rundownCommand: ["node", "dist/cli.js"],
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "arg",
      parentKeepArtifacts: true,
      parentShowAgentOutput: true,
      parentIgnoreCliBlock: true,
      parentVerify: false,
      parentNoRepair: true,
      parentRepairAttempts: 2,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "delegated", stderr: "" });
  });

  it("task verification adapter delegates to verify", async () => {
    verifyMock.mockResolvedValue(true);

    const verificationStore = {
      write: vi.fn(),
      read: vi.fn(() => null),
      remove: vi.fn(),
    };
    const adapter = createTaskVerificationAdapter(verificationStore);
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
      isRundownTask: false,
      depth: 0,
      children: [],
      subItems: [],
    };
    const templateVars = { owner: "cli" };
    const artifactContext = { runId: "run-3" };
    const cliBlockExecutor = { execute: vi.fn() };
    const cliExecutionOptions = { timeoutMs: 1234 };
    const result = await adapter.verify({
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
      cliBlockExecutor,
      cliExecutionOptions,
    });

    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledWith({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      template: "{{task}}",
      command: ["worker", "run"],
      verificationStore,
      mode: "wait",
      transport: "arg",
      cwd: "/repo",
      templateVars,
      artifactContext,
      cliBlockExecutor,
      cliExecutionOptions,
    });
    expect(result).toBe(true);
  });

  it("task repair adapter delegates to repair", async () => {
    repairMock.mockResolvedValue({ valid: true, attempts: 1 });

    const verificationStore = {
      write: vi.fn(),
      read: vi.fn(() => null),
      remove: vi.fn(),
    };
    const adapter = createTaskRepairAdapter(verificationStore);
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
      isRundownTask: false,
      depth: 0,
      children: [],
      subItems: [],
    };
    const templateVars = { owner: "cli" };
    const artifactContext = { runId: "run-4" };
    const cliBlockExecutor = { execute: vi.fn() };
    const cliExecutionOptions = { timeoutMs: 5678 };
    const result = await adapter.repair({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      repairTemplate: "repair",
      verifyTemplate: "verify",
      command: ["worker", "run"],
      maxRetries: 2,
      mode: "wait",
      transport: "file",
      cwd: "/repo",
      templateVars,
      artifactContext,
      cliBlockExecutor,
      cliExecutionOptions,
    });

    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock).toHaveBeenCalledWith({
      task,
      source: "tasks.md",
      contextBefore: "# Tasks",
      repairTemplate: "repair",
      verifyTemplate: "verify",
      command: ["worker", "run"],
      maxRetries: 2,
      verificationStore,
      mode: "wait",
      transport: "file",
      cwd: "/repo",
      templateVars,
      artifactContext,
      cliBlockExecutor,
      cliExecutionOptions,
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
