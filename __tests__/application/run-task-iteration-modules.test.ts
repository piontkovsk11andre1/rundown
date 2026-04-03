import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareTaskPrompts } from "../../src/application/prepare-task-prompts.js";
import { handleDryRunOrPrintPrompt } from "../../src/application/dry-run-dispatch.js";
import { dispatchTaskExecution } from "../../src/application/task-execution-dispatch.js";
import { completeTaskIteration } from "../../src/application/complete-task-iteration.js";
import { runTraceEnrichment } from "../../src/application/trace-enrichment.js";
import { createTraceRunSession } from "../../src/application/trace-run-session.js";
import * as verifyRepairLoopModule from "../../src/application/verify-repair-loop.js";
import * as runLifecycleModule from "../../src/application/run-lifecycle.js";
import * as checkboxOperationsModule from "../../src/application/checkbox-operations.js";
import type { Task } from "../../src/domain/parser.js";
import {
  createDependencies,
  createGitClientMock,
  createInMemoryFileSystem,
  createInlineTask,
  createTask,
} from "./run-task-test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepare-task-prompts", () => {
  it("expands source, task-template, and verify-template cli blocks with phase labels", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.templateLoader.load = vi.fn((templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "Execute {{task}}\n```cli\necho task-template\n```";
      }
      if (templatePath.endsWith("verify.md")) {
        return "Verify {{task}}\n```cli\necho verify-template\n```";
      }
      return null;
    });

    const cliCalls: Array<{ command: string; cwd: string; options: unknown }> = [];
    const cliBlockExecutor = {
      execute: vi.fn(async (command: string, commandCwd: string, options) => {
        cliCalls.push({ command, cwd: commandCwd, options });
        return {
          exitCode: 0,
          stdout: "ok: " + command,
          stderr: "",
        };
      }),
    };

    const result = await prepareTaskPrompts({
      dependencies,
      task,
      fileSource: [
        "- [ ] Ship release",
        "```cli",
        "echo source",
        "```",
      ].join("\n"),
      sourceDir: cwd,
      shouldVerify: true,
      trace: true,
      extraTemplateVars: {},
      cliExpansionEnabled: true,
      ignoreCliBlock: false,
      cliExecutionOptions: { timeoutMs: 50 },
      artifactContext: {
        runId: "run-prepare",
        rootDir: path.join(cwd, ".rundown", "runs", "run-prepare"),
        cwd,
        keepArtifacts: true,
        commandName: "run",
      },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      cliBlockExecutor,
      nowIso: () => "2026-01-01T00:00:00.000Z",
      emit: vi.fn(),
      onTemplateCliFailure: vi.fn(async () => null),
    });

    expect("earlyExitCode" in result).toBe(false);
    if ("earlyExitCode" in result) {
      return;
    }

    expect(result.dryRunCliBlockCount).toBe(3);
    expect(result.prompt).toContain("echo task-template");
    expect(result.verificationPrompt).toContain("echo verify-template");

    expect(cliCalls.map((call) => call.command)).toEqual([
      "echo source",
      "echo task-template",
      "echo verify-template",
    ]);
    expect(cliCalls.map((call) => (call.options as { artifactPhaseLabel?: string }).artifactPhaseLabel)).toEqual([
      "cli-source",
      "cli-task-template",
      "cli-verify-template",
    ]);
  });

  it("returns earlyExitCode when template cli expansion fails", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.templateLoader.load = vi.fn((templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "```cli\necho task-template\n```";
      }
      return null;
    });

    const onTemplateCliFailure = vi.fn(async () => 9);
    const result = await prepareTaskPrompts({
      dependencies,
      task,
      fileSource: "- [ ] Ship release",
      sourceDir: cwd,
      shouldVerify: false,
      trace: false,
      extraTemplateVars: {},
      cliExpansionEnabled: true,
      ignoreCliBlock: false,
      cliExecutionOptions: undefined,
      artifactContext: null,
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      cliBlockExecutor: {
        execute: vi.fn(async () => ({
          exitCode: 2,
          stdout: "",
          stderr: "failed",
        })),
      },
      nowIso: () => "2026-01-01T00:00:00.000Z",
      emit: vi.fn(),
      onTemplateCliFailure,
    });

    expect(result).toEqual({ earlyExitCode: 9 });
    expect(onTemplateCliFailure).toHaveBeenCalledTimes(1);
  });

  it("injects memory path and summary into run prompts without inlining memory body text", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    const memoryBodyText = "MEMORY-BODY-SHOULD-NOT-BE-INLINED";
    const memoryFilePath = path.join(cwd, ".rundown", "tasks.memory.md");
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: true,
        filePath: memoryFilePath,
        summary: "Release decisions and follow-ups",
      })),
    };

    dependencies.templateLoader.load = vi.fn((templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "Execute {{task}}\nMemory path: {{memoryFilePath}}\nMemory summary: {{memorySummary}}";
      }
      if (templatePath.endsWith("verify.md")) {
        return "Verify {{task}}\nMemory path: {{memoryFilePath}}\nMemory summary: {{memorySummary}}";
      }
      return null;
    });

    const result = await prepareTaskPrompts({
      dependencies,
      task,
      fileSource: "- [ ] Ship release",
      sourceDir: cwd,
      shouldVerify: true,
      trace: false,
      extraTemplateVars: {},
      cliExpansionEnabled: true,
      ignoreCliBlock: false,
      cliExecutionOptions: undefined,
      artifactContext: null,
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      cliBlockExecutor: {
        execute: vi.fn(async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
      nowIso: () => "2026-01-01T00:00:00.000Z",
      emit: vi.fn(),
      onTemplateCliFailure: vi.fn(async () => null),
    });

    expect("earlyExitCode" in result).toBe(false);
    if ("earlyExitCode" in result) {
      return;
    }

    expect(result.prompt).toContain("Memory path: " + memoryFilePath);
    expect(result.prompt).toContain("Memory summary: Release decisions and follow-ups");
    expect(result.verificationPrompt).toContain("Memory path: " + memoryFilePath);
    expect(result.verificationPrompt).toContain("Memory summary: Release decisions and follow-ups");
    expect(result.prompt).not.toContain(memoryBodyText);
    expect(result.verificationPrompt).not.toContain(memoryBodyText);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(taskFile);
  });
});

describe("dry-run-dispatch", () => {
  const taskFile = "/workspace/tasks.md";

  it("routes verify-only dry runs to verification output", () => {
    const emit = vi.fn();
    const code = handleDryRunOrPrintPrompt({
      emit,
      printPrompt: false,
      dryRun: true,
      dryRunSuppressesCliExpansion: true,
      dryRunCliBlockCount: 2,
      onlyVerify: true,
      task: createTask(taskFile, "Ship release"),
      prompt: "unused",
      verificationPrompt: "verify prompt",
      automationCommand: ["opencode", "run"],
      resolvedWorkerCommand: ["opencode", "run"],
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "info",
      message: "Dry run — would run verification with: opencode run",
    }));
  });

  it("routes inline cli print-prompt to inline output", () => {
    const emit = vi.fn();
    const code = handleDryRunOrPrintPrompt({
      emit,
      printPrompt: true,
      dryRun: false,
      dryRunSuppressesCliExpansion: false,
      dryRunCliBlockCount: 0,
      onlyVerify: false,
      task: createInlineTask(taskFile, "cli: npm test"),
      prompt: "unused",
      verificationPrompt: "unused",
      automationCommand: ["opencode", "run"],
      resolvedWorkerCommand: ["opencode", "run"],
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith({ kind: "text", text: "cli: npm test" });
  });

});

describe("task-execution-dispatch", () => {
  const cwd = "/workspace";
  const traceWriter = {
    write: vi.fn(),
    flush: vi.fn(),
  };

  function createSession() {
    return createTraceRunSession({
      getTraceWriter: () => traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: true,
    });
  }

  function createArtifactContext() {
    return {
      runId: "run-dispatch",
      rootDir: path.join(cwd, ".rundown", "runs", "run-dispatch"),
      cwd,
      keepArtifacts: true,
      commandName: "run",
    };
  }

  it("normalizes only-verify mode and flushes pending reset traces", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const session = createSession();
    const pendingResets = [{ file: task.file, resetCount: 1, dryRun: false }];
    const verifyOnlyOptions = { timeoutMs: 15 };

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: pendingResets,
      traceRunSession: session,
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: true,
      onlyVerify: true,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: verifyOnlyOptions,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: { timeoutMs: 20 },
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: true,
      cliExecutionOptionsForVerification: verifyOnlyOptions,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    });
    expect(pendingResets).toHaveLength(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
  });

  it("normalizes inline cli failure into execution-failed result", async () => {
    const task = createInlineTask(path.join(cwd, "tasks.md"), "cli: npm test");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] cli: npm test\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 3,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Inline CLI exited with code 3",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 3,
    });
    expect(events).toContainEqual({ kind: "text", text: "inline out" });
    expect(events).toContainEqual({ kind: "stderr", text: "inline err" });
  });

  it("keeps inline cli stdout/stderr hidden when show-agent-output is disabled while preserving lifecycle status", async () => {
    const task = createInlineTask(path.join(cwd, "tasks.md"), "cli: npm test");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] cli: npm test\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(events.some((event) => event.kind === "text" || event.kind === "stderr")).toBe(false);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Executing inline CLI:"))).toBe(true);
  });

  it("returns detached for detached worker mode", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "detached",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({ kind: "detached" });
  });

  it("keeps default worker stdout/stderr hidden when show-agent-output is disabled while preserving lifecycle status", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "worker out",
      stderr: "worker err",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(events.some((event) => event.kind === "text" || event.kind === "stderr")).toBe(false);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Running: opencode run"))).toBe(true);
  });

  it("preserves default execute-and-verify lifecycle metadata for non-memory tasks", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "done",
      stderr: "",
    }));
    const verifyAfterExecuteOptions = { timeoutMs: 45 };

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: verifyAfterExecuteOptions,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: true,
      cliExecutionOptionsForVerification: verifyAfterExecuteOptions,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    });
  });

  it("preserves non-memory execution failure exit-code mapping across default and cli routes", async () => {
    const defaultTask = createTask(path.join(cwd, "tasks-default.md"), "Ship release");
    const defaultFileSystem = createInMemoryFileSystem({
      [defaultTask.file]: "- [ ] Ship release\n",
    });
    const defaultDeps = createDependencies({
      cwd,
      task: defaultTask,
      fileSystem: defaultFileSystem,
      gitClient: createGitClientMock(),
    });
    defaultDeps.dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 7,
      stdout: "",
      stderr: "worker failed",
    }));

    const defaultResult = await dispatchTaskExecution({
      dependencies: defaultDeps.dependencies,
      emit: (event) => defaultDeps.events.push(event),
      files: [defaultTask.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task: defaultTask,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(defaultResult).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Worker exited with code 7.",
      executionFailureRunReason: "Worker exited with a non-zero code.",
      executionFailureExitCode: 7,
    });

    const cliTask = createInlineTask(path.join(cwd, "tasks-cli.md"), "cli: npm test");
    const cliFileSystem = createInMemoryFileSystem({
      [cliTask.file]: "- [ ] cli: npm test\n",
    });
    const cliDeps = createDependencies({
      cwd,
      task: cliTask,
      fileSystem: cliFileSystem,
      gitClient: createGitClientMock(),
    });
    cliDeps.dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 5,
      stdout: "",
      stderr: "inline failed",
    }));

    const cliResult = await dispatchTaskExecution({
      dependencies: cliDeps.dependencies,
      emit: (event) => cliDeps.events.push(event),
      files: [cliTask.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      task: cliTask,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(cliResult).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Inline CLI exited with code 5",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 5,
    });

  });

  it("persists worker output for memory-capture tasks", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Capture release memory");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Capture release memory\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const canonicalTaskPath = path.resolve(task.file);
    const memoryFilePath = path.join(path.dirname(canonicalTaskPath), ".rundown", "tasks.md.memory.md");
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: false,
        filePath: memoryFilePath,
        summary: undefined,
      })),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "Captured release context\n- Owner: platform",
      stderr: "",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(fileSystem.readText(memoryFilePath)).toContain("Captured release context");

    const memoryIndexPath = path.join(path.dirname(memoryFilePath), "memory-index.json");
    const index = JSON.parse(fileSystem.readText(memoryIndexPath)) as Record<string, { summary?: string }>;
    const canonicalSourcePath = path.resolve(task.file);
    expect(index[canonicalSourcePath]?.summary).toBe("Captured release context");
  });

  it("passes memory capture prefix through to memory writer for index metadata composition", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "remember: capture release memory");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] remember: capture release memory\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "Captured release context",
      stderr: "",
    }));
    dependencies.memoryWriter = {
      write: vi.fn(() => ({
        ok: true as const,
        value: {
          memoryFilePath: "/workspace/.rundown/tasks.md.memory.md",
          memoryIndexPath: "/workspace/.rundown/memory-index.json",
          canonicalSourcePath: path.resolve(task.file),
        },
      })),
    };

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      memoryCapturePrefix: "remember",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(dependencies.memoryWriter.write).toHaveBeenCalledWith({
      sourcePath: task.file,
      workerOutput: "Captured release context",
      capturePrefix: "remember",
    });
  });

  it("fails memory-capture tasks when worker output is empty", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Capture release memory");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Capture release memory\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: false,
        filePath: path.join(cwd, ".rundown", "tasks.md.memory.md"),
        summary: undefined,
      })),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "   \n\t ",
      stderr: "",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Memory capture worker returned empty output; nothing to persist.",
      executionFailureRunReason: "Memory capture worker returned empty output.",
      executionFailureExitCode: 1,
    });
  });

  it("emits warning when memory body persists but index update fails", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Capture release memory");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Capture release memory\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "Captured release context",
      stderr: "",
    }));
    dependencies.memoryWriter = {
      write: vi.fn(() => ({
        ok: false as const,
        error: {
          message: "Memory body was written to /workspace/.rundown/tasks.md.memory.md but updating memory index failed at /workspace/.rundown/memory-index.json: Error: rename failed",
          reason: "Memory index update failed after writing memory body.",
          warningMessage: "Memory capture output was persisted to /workspace/.rundown/tasks.md.memory.md, but memory index metadata could not be updated.",
        },
      })),
    };

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage:
        "Memory body was written to /workspace/.rundown/tasks.md.memory.md but updating memory index failed at /workspace/.rundown/memory-index.json: Error: rename failed",
      executionFailureRunReason: "Memory index update failed after writing memory body.",
      executionFailureExitCode: 1,
    });
    expect(events).toContainEqual({
      kind: "warn",
      message:
        "Memory capture output was persisted to /workspace/.rundown/tasks.md.memory.md, but memory index metadata could not be updated.",
    });
  });

  it("rejects detached mode for memory-capture tasks", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Capture release memory");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Capture release memory\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "detached",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage:
        "Memory capture tasks do not support detached mode because worker output is required for persistence.",
      executionFailureRunReason: "Memory capture task cannot persist memory in detached mode.",
      executionFailureExitCode: 1,
    });
  });

  it("preserves verify-only precedence when task intent is memory-capture", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "Capture release memory");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Capture release memory\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: true,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: { timeoutMs: 25 },
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: { timeoutMs: 30 },
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: true,
      cliExecutionOptionsForVerification: { timeoutMs: 25 },
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    });
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
  });

  it("keeps task-derived verify-only execution on the existing verification lifecycle", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "verify: release notes are aligned");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] verify: release notes are aligned\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const verifyOnlyOptions = { timeoutMs: 22 };

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: true,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "verify-only",
      task,
      prompt: "prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: verifyOnlyOptions,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: { timeoutMs: 31 },
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: true,
      cliExecutionOptionsForVerification: verifyOnlyOptions,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "Verify-only task mode — skipping task execution.",
    });
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
  });

  it("preserves inline cli routing precedence over memory-capture intent", async () => {
    const task = createInlineTask(path.join(cwd, "tasks.md"), "cli: npm test");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] cli: npm test\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const memoryFilePath = path.join(cwd, ".rundown", "tasks.md.memory.md");
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: false,
        filePath: memoryFilePath,
        summary: undefined,
      })),
    };
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      pendingPreRunResetTraceEvents: [],
      traceRunSession: createSession(),
      roundContext: {
        currentRound: 1,
        totalRounds: 1,
      },
      configuredOnlyVerify: false,
      onlyVerify: false,
      shouldVerify: true,
      mode: "wait",
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      task,
      prompt: "capture memory",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledTimes(1);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.memoryResolver.resolve).not.toHaveBeenCalled();
    expect(fileSystem.exists(memoryFilePath)).toBe(false);
  });

});

describe("complete-task-iteration", () => {
  const cwd = "/workspace";
  const task = createTask(path.join(cwd, "tasks.md"), "Ship release");

  function createCompletionSession() {
    return {
      beginPhase: vi.fn(() => ({ phase: "verify", sequence: 1, startedAtMs: 1, startedAtIso: "2026-01-01T00:00:00.000Z" })),
      emitPromptMetrics: vi.fn(),
      completePhase: vi.fn(),
    } as unknown as ReturnType<typeof createTraceRunSession>;
  }

  it("fails iteration when verification result is invalid", async () => {
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Ship release\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = vi.fn();
    const failRun = vi.fn(async () => 2);

    vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop").mockResolvedValue({
      valid: false,
      failureReason: "missing tests",
    });
    vi.spyOn(runLifecycleModule, "afterTaskFailed").mockResolvedValue();
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});

    const result = await completeTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
      },
      traceRunSession: createCompletionSession(),
      failRun,
      finishRun: vi.fn(async () => 0),
      resetArtifacts: vi.fn(),
      keepArtifacts: true,
      effectiveRunAll: false,
      commitAfterComplete: false,
      deferCommitUntilPostRun: false,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
      onFailCommand: undefined,
      hideHookOutput: false,
      maxRepairAttempts: 1,
      allowRepair: true,
      transport: "file",
      trace: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task,
      sourceText: "- [ ] Ship release",
      expandedSource: "- [ ] Ship release",
      expandedContextBefore: "",
      templates: {
        task: "",
        discuss: "",
        research: "",
        verify: "{{task}}",
        repair: "{{task}}",
        plan: "",
        trace: "",
      },
      templateVarsWithTrace: {},
      automationCommand: ["opencode", "run"],
      shouldVerify: true,
      verificationPrompt: "verify",
      artifactContext: {
        runId: "run-complete",
        rootDir: path.join(cwd, ".rundown", "runs", "run-complete"),
        cwd,
        keepArtifacts: true,
        commandName: "run",
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      verificationFailureMessage: "Verification failed. Task not checked.",
      verificationFailureRunReason: "Verification failed.",
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 2 });
    expect(emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Verification failed. Task not checked.\nmissing tests",
    });
    expect(failRun).toHaveBeenCalledWith(2, "verification-failed", "Verification failed.", 2);
  });

  it("completes task and continues loop when run-all is enabled", async () => {
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] Ship release\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const state = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };

    vi.spyOn(runLifecycleModule, "afterTaskComplete").mockResolvedValue({ commit: "ok" });
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});
    const finishRun = vi.fn(async () => 0);
    const resetArtifacts = vi.fn();

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun,
      resetArtifacts,
      keepArtifacts: true,
      effectiveRunAll: true,
      commitAfterComplete: true,
      deferCommitUntilPostRun: true,
      commitMessageTemplate: "done: {{task}}",
      onCompleteCommand: undefined,
      onFailCommand: undefined,
      hideHookOutput: false,
      maxRepairAttempts: 1,
      allowRepair: true,
      transport: "file",
      trace: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task,
      sourceText: "- [ ] Ship release",
      expandedSource: "- [ ] Ship release",
      expandedContextBefore: "",
      templates: {
        task: "",
        discuss: "",
        research: "",
        verify: "",
        repair: "",
        plan: "",
        trace: "",
      },
      templateVarsWithTrace: {},
      automationCommand: ["opencode", "run"],
      shouldVerify: false,
      verificationPrompt: "",
      artifactContext: {
        runId: "run-complete",
        rootDir: path.join(cwd, ".rundown", "runs", "run-complete"),
        cwd,
        keepArtifacts: true,
        commandName: "run",
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      verificationFailureMessage: "unused",
      verificationFailureRunReason: "unused",
    });

    expect(result).toEqual({ continueLoop: true });
    expect(state.tasksCompleted).toBe(1);
    expect(state.deferredCommitContext).toEqual({
      task,
      source: "- [ ] Ship release",
    });
    expect(finishRun).toHaveBeenCalledWith(0, "completed", true, undefined, { commit: "ok" });
    expect(resetArtifacts).toHaveBeenCalledTimes(1);
  });
});

describe("trace-enrichment", () => {
  it("queues analysis summary payload when enrichment worker succeeds", async () => {
    const cwd = "/workspace";
    const task = createTask(path.join(cwd, "tasks.md"), "Ship release");
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };
    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: true,
    });
    const artifactContext = {
      runId: "run-trace",
      rootDir: path.join(cwd, ".rundown", "runs", "run-trace"),
      cwd,
      keepArtifacts: true,
      commandName: "run",
    };
    traceRunSession.startRun({
      artifactContext,
      task,
      worker: ["opencode", "run"],
      metrics: {
        sourceFilesScanned: 1,
        totalUncheckedTasks: 1,
        taskPositionInFile: 1,
        hasSubtasks: false,
      },
      isVerifyOnly: false,
      contextBefore: "",
    });

    const queueSpy = vi.spyOn(traceRunSession, "queueAnalysisSummary");
    const fileSystem = createInMemoryFileSystem({});
    fileSystem.readdir = vi.fn(() => []);
    const workerExecutor = {
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "medium",
            execution_quality: "clean",
            direction_changes: 0,
            modules_touched: ["src/application/run-task-iteration.ts"],
            wasted_effort_pct: 0,
            key_decisions: ["kept parity"],
            risk_flags: [],
            improvement_suggestions: [],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      })),
      executeInlineCli: vi.fn(),
    };
    const emit = vi.fn();

    await runTraceEnrichment({
      trace: true,
      status: "completed",
      artifactContext,
      traceRunSession,
      traceEnrichmentContext: {
        task,
        source: "- [ ] Ship release",
        contextBefore: "",
        worker: ["opencode", "run"],
        templates: {
          task: "",
          discuss: "",
          research: "",
          verify: "",
          repair: "",
          plan: "",
          trace: "Trace {{runId}} {{status}}",
        },
      },
      dependencies: {
        fileSystem,
        pathOperations: path,
        workerExecutor: workerExecutor as never,
        workingDirectory: { cwd: () => cwd },
        configDir: undefined,
      },
      transport: "file",
      emit,
    });

    expect(workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(queueSpy).toHaveBeenCalledWith(expect.objectContaining({
      task_complexity: "medium",
    }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "warn" }));
  });

  it("warns and skips queueing when enrichment worker fails", async () => {
    const cwd = "/workspace";
    const task = createTask(path.join(cwd, "tasks.md"), "Ship release");
    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => ({ write: vi.fn(), flush: vi.fn() }),
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: true,
    });
    const artifactContext = {
      runId: "run-trace-fail",
      rootDir: path.join(cwd, ".rundown", "runs", "run-trace-fail"),
      cwd,
      keepArtifacts: true,
      commandName: "run",
    };
    traceRunSession.startRun({
      artifactContext,
      task,
      worker: ["opencode", "run"],
      metrics: {
        sourceFilesScanned: 1,
        totalUncheckedTasks: 1,
        taskPositionInFile: 1,
        hasSubtasks: false,
      },
      isVerifyOnly: false,
      contextBefore: "",
    });
    const queueSpy = vi.spyOn(traceRunSession, "queueAnalysisSummary");
    const emit = vi.fn();
    const workerExecutor = {
      runWorker: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "failure" })),
      executeInlineCli: vi.fn(),
    };

    await runTraceEnrichment({
      trace: true,
      status: "completed",
      artifactContext,
      traceRunSession,
      traceEnrichmentContext: {
        task,
        source: "- [ ] Ship release",
        contextBefore: "",
        worker: ["opencode", "run"],
        templates: {
          task: "",
          discuss: "",
          research: "",
          verify: "",
          repair: "",
          plan: "",
          trace: "Trace {{runId}}",
        },
      },
      dependencies: {
        fileSystem: createInMemoryFileSystem({}),
        pathOperations: path,
        workerExecutor: workerExecutor as never,
        workingDirectory: { cwd: () => cwd },
        configDir: undefined,
      },
      transport: "file",
      emit,
    });

    expect(queueSpy).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Trace enrichment worker did not complete successfully; skipping analysis.summary event.",
    });
  });
});
