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
      transport: "file",
      keepArtifacts: false,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 2,
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
      transport: "file",
      keepArtifacts: false,
      showAgentOutput: true,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 1,
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith({ kind: "text", text: "cli: npm test" });
  });

  it("routes rundown dry runs to delegated rundown command preview", () => {
    const emit = vi.fn();
    const task: Task = {
      ...createTask(taskFile, "rundown: child.md"),
      isRundownTask: true,
      rundownArgs: "child.md --verify",
    };

    const code = handleDryRunOrPrintPrompt({
      emit,
      printPrompt: false,
      dryRun: true,
      dryRunSuppressesCliExpansion: false,
      dryRunCliBlockCount: 0,
      onlyVerify: false,
      task,
      prompt: "unused",
      verificationPrompt: "unused",
      automationCommand: ["opencode", "run"],
      resolvedWorkerCommand: ["opencode", "run"],
      transport: "file",
      keepArtifacts: true,
      showAgentOutput: true,
      ignoreCliBlock: true,
      verify: false,
      noRepair: false,
      repairAttempts: 2,
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "info",
      message: expect.stringContaining("Dry run — would execute rundown task: rundown run child.md --verify"),
    }));
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
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
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
      executeRundownTask: vi.fn(),
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
          verify: "",
          repair: "",
          plan: "",
          trace: "Trace {{runId}} {{status}}",
        },
      },
      dependencies: {
        fileSystem,
        pathOperations: path,
        workerExecutor,
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
          verify: "",
          repair: "",
          plan: "",
          trace: "Trace {{runId}}",
        },
      },
      dependencies: {
        fileSystem: createInMemoryFileSystem({}),
        pathOperations: path,
        workerExecutor: {
          runWorker: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "failure" })),
          executeInlineCli: vi.fn(),
          executeRundownTask: vi.fn(),
        },
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
