import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareTaskPrompts } from "../../src/application/prepare-task-prompts.js";
import { handleDryRunOrPrintPrompt } from "../../src/application/dry-run-dispatch.js";
import { dispatchTaskExecution } from "../../src/application/task-execution-dispatch.js";
import { completeTaskIteration } from "../../src/application/complete-task-iteration.js";
import { runTaskIteration } from "../../src/application/run-task-iteration.js";
import { runTraceEnrichment } from "../../src/application/trace-enrichment.js";
import { createTraceRunSession } from "../../src/application/trace-run-session.js";
import { includeHandler } from "../../src/domain/builtin-tools/include.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import { parseTasks } from "../../src/domain/parser.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import * as verifyRepairLoopModule from "../../src/application/verify-repair-loop.js";
import * as runLifecycleModule from "../../src/application/run-lifecycle.js";
import * as checkboxOperationsModule from "../../src/application/checkbox-operations.js";
import * as taskExecutionDispatchModule from "../../src/application/task-execution-dispatch.js";
import * as completeTaskIterationModule from "../../src/application/complete-task-iteration.js";
import type { Task } from "../../src/domain/parser.js";
import {
  MEMORY_PREFIX_ALIASES,
  PARALLEL_PREFIX_ALIASES,
  VERIFY_PREFIX_ALIASES,
} from "../helpers/prefix-aliases.js";
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

  it("renders {{userVariables}} in prompt output", async () => {
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
        return "Execute {{task}}\nVariables:\n{{userVariables}}";
      }
      if (templatePath.endsWith("verify.md")) {
        return "Verify {{task}}\nVariables:\n{{userVariables}}";
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
      extraTemplateVars: {
        ticket: "ENG-42",
        branch: "main",
      },
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

    const renderedVars = "branch=main\nticket=ENG-42";
    expect(result.prompt).toContain("Variables:\n" + renderedVars);
    expect(result.verificationPrompt).toContain("Variables:\n" + renderedVars);
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

  it("renders inline cli print-prompt with directive cli args", () => {
    const emit = vi.fn();
    const code = handleDryRunOrPrintPrompt({
      emit,
      printPrompt: true,
      dryRun: false,
      dryRunSuppressesCliExpansion: false,
      dryRunCliBlockCount: 0,
      onlyVerify: false,
      task: {
        ...createInlineTask(taskFile, "cli: npm test"),
        cliCommand: "npm test",
        directiveCliArgs: "--worker opencode",
      },
      prompt: "unused",
      verificationPrompt: "unused",
      automationCommand: ["opencode", "run"],
      resolvedWorkerCommand: ["opencode", "run"],
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith({ kind: "text", text: "cli: npm test --worker opencode" });
  });

  it("renders inline cli dry-run output with directive cli args", () => {
    const emit = vi.fn();
    const code = handleDryRunOrPrintPrompt({
      emit,
      printPrompt: false,
      dryRun: true,
      dryRunSuppressesCliExpansion: false,
      dryRunCliBlockCount: 0,
      onlyVerify: false,
      task: {
        ...createInlineTask(taskFile, "cli: npm test"),
        cliCommand: "npm test",
        directiveCliArgs: "--worker opencode",
      },
      prompt: "unused",
      verificationPrompt: "unused",
      automationCommand: ["opencode", "run"],
      resolvedWorkerCommand: ["opencode", "run"],
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "info",
      message: "Dry run — would execute inline CLI: npm test --worker opencode",
    }));
  });

  it("renders inline cli dry-run output with quoted directive cli args", () => {
    const emit = vi.fn();
    const code = handleDryRunOrPrintPrompt({
      emit,
      printPrompt: false,
      dryRun: true,
      dryRunSuppressesCliExpansion: false,
      dryRunCliBlockCount: 0,
      onlyVerify: false,
      task: {
        ...createInlineTask(taskFile, "cli: npm test"),
        cliCommand: "npm test",
        directiveCliArgs: "--worker \"my worker\"",
      },
      prompt: "unused",
      verificationPrompt: "unused",
      automationCommand: ["opencode", "run"],
      resolvedWorkerCommand: ["opencode", "run"],
    });

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "info",
      message: "Dry run — would execute inline CLI: npm test --worker \"my worker\"",
    }));
  });

});

describe("run-task-iteration", () => {
  it("re-parses normalized fast payload so loop aliases still route through built-in handler", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const taskText = "fast: each: service-a, service-b";
    const task = createTask(taskFile, taskText);
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: `- [ ] ${taskText}\n`,
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    const dispatchSpy = vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockImplementation(async (params) => {
      expect(params.task.text).toBe("each: service-a, service-b");
      expect(params.prefixChain?.handler?.tool.name).toBe("for");
      expect(params.prefixChain?.handler?.payload).toBe("service-a, service-b");
      return {
        kind: "ready-for-completion",
        shouldVerify: false,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
      };
    });
    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration").mockResolvedValue({
      continueLoop: false,
      exitCode: 0,
    });

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: `- [ ] ${taskText}`,
        fileSource: `- [ ] ${taskText}`,
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        forceAttempts: 2,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
        traceOnly: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        cwd,
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("emits group-start with task counter before dispatching task execution", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    const dispatchSpy = vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockImplementation(async () => {
      expect(events[0]).toEqual(expect.objectContaining({
        kind: "group-start",
        counter: {
          current: 3,
          total: 10,
        },
      }));
      if (events[0]?.kind === "group-start") {
        expect(events[0].label).toContain("Ship release");
      }
      return {
        kind: "ready-for-completion",
        shouldVerify: true,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
      };
    });

    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration");

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: "- [ ] Ship release",
        fileSource: "- [ ] Ship release",
        taskIndex: 2,
        totalTasks: 10,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 2,
        totalTasks: 10,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("emits group-end success after task completion", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockResolvedValue({
      kind: "ready-for-completion",
      shouldVerify: false,
      executionStdout: "provider limit message",
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    });

    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration").mockResolvedValue({
      continueLoop: false,
      exitCode: 0,
    });

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: "- [ ] Ship release",
        fileSource: "- [ ] Ship release",
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(events).toContainEqual({ kind: "group-end", status: "success" });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy.mock.calls[0]?.[0]?.executionStdout).toBeUndefined();
  });

  it("forwards skipRemainingSiblingsReason from dispatch to completion", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "end: no output to process");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] end: no output to process\n- [ ] Do this and that\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockResolvedValue({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: "no output to process",
    });

    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration").mockResolvedValue({
      continueLoop: false,
      exitCode: 0,
    });

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: "- [ ] end: no output to process\n- [ ] Do this and that\n",
        fileSource: "- [ ] end: no output to process\n- [ ] Do this and that\n",
        taskIndex: 0,
        totalTasks: 2,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 2,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy.mock.calls[0]?.[0]?.skipRemainingSiblingsReason).toBe("no output to process");
  });

  it("emits group-end failure when task execution fails", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockResolvedValue({
      kind: "execution-failed",
      executionFailureMessage: "Worker exited with code 2.",
      executionFailureRunReason: "execution-failed",
      executionFailureExitCode: 2,
    });

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    const failRun = vi.fn(async () => 2);

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: "- [ ] Ship release",
        fileSource: "- [ ] Ship release",
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun,
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(events).toContainEqual({
      kind: "group-end",
      status: "failure",
      message: "execution-failed",
    });
    expect(failRun).toHaveBeenCalledWith(1, "execution-failed", "execution-failed", 2);
  });

  it("emits group-end failure when iteration throws unexpectedly", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Ship release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Ship release\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockRejectedValue(new Error("unexpected dispatch failure"));

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await expect(runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: "- [ ] Ship release",
        fileSource: "- [ ] Ship release",
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    })).rejects.toThrow("unexpected dispatch failure");

    expect(events).toContainEqual({
      kind: "group-end",
      status: "failure",
      message: "unexpected dispatch failure",
    });
  });

  it.each([
    { taskText: "fast: Ship release", normalizedTaskText: "Ship release" },
    { taskText: "raw: Ship release", normalizedTaskText: "Ship release" },
  ])("executes normalized task text for $taskText before worker handoff", async ({ taskText, normalizedTaskText }) => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, taskText);
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: `- [ ] ${taskText}\n`,
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    const dispatchSpy = vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution").mockImplementation(async (params) => {
      expect(params.task.text).toBe(normalizedTaskText);
      return {
        kind: "ready-for-completion",
        shouldVerify: false,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
      };
    });
    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration").mockResolvedValue({
      continueLoop: false,
      exitCode: 0,
    });

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: `- [ ] ${taskText}`,
        fileSource: `- [ ] ${taskText}`,
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("persists memory-prefixed task output via configured memory writer", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const taskText = "memory: capture release decisions";
    const task = createTask(taskFile, taskText);
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: `- [ ] ${taskText}\n`,
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "Captured release decisions\n- owner: platform",
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

    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration").mockResolvedValue({
      continueLoop: false,
      exitCode: 0,
    });

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: `- [ ] ${taskText}`,
        fileSource: `- [ ] ${taskText}`,
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: false,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(dependencies.memoryWriter.write).toHaveBeenCalledWith({
      sourcePath: task.file,
      workerOutput: "Captured release decisions\n- owner: platform",
      capturePrefix: "memory",
      originTask: {
        text: "capture release decisions",
        line: task.line,
      },
    });
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps loop parent unchecked on first minimal for-loop pass and emits advance signals", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "for: Alpha, Beta", {
      children: [
        createTask(taskFile, "Do this", {
          index: 1,
          line: 2,
          depth: 1,
        }),
        createTask(taskFile, "Do that", {
          index: 2,
          line: 3,
          depth: 1,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] for: Alpha, Beta",
        "  - [ ] Do this",
        "  - [ ] Do that",
        "",
      ].join("\n"),
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "- for-item: Alpha",
        "- for-item: Beta",
      ].join("\n"),
      stderr: "",
    }));
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };
    const completeSpy = vi.spyOn(completeTaskIterationModule, "completeTaskIteration");
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    const result = await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: fileSystem.readText(taskFile),
        fileSource: fileSystem.readText(taskFile),
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        forceAttempts: 2,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
        traceOnly: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: true,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(result.continueLoop).toBe(true);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy.mock.calls[0]?.[0]?.forLoopAdvanced).toEqual({
      current: "Alpha",
      remainingItems: 1,
    });
    expect(completeSpy.mock.calls[0]?.[0]?.forLoopCompleted).toBeUndefined();
    expect(fileSystem.readText(taskFile)).toBe([
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Alpha",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "",
    ].join("\n"));

    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Loop advanced to item:"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Loop completed"))).toBe(false);
    expect(events.some((event) => event.kind === "success" && event.message.startsWith("Task checked:"))).toBe(false);
  });

  it.each(["fast:", "raw:"])("skips %s tasks that have no payload text without invoking worker execution", async (taskText) => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, taskText);
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: `- [ ] ${taskText}\n`,
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const emit = (event: Parameters<typeof runTaskIteration>[0]["emit"] extends (arg: infer T) => void ? T : never) => {
      events.push(event);
    };

    const dispatchSpy = vi.spyOn(taskExecutionDispatchModule, "dispatchTaskExecution");

    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => dependencies.traceWriter,
      source: "tasks.md",
      mode: "wait",
      transport: "file",
      traceEnabled: false,
    });

    const result = await runTaskIteration({
      dependencies,
      emit,
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
        artifactContext: null,
        traceEnrichmentContext: null,
      },
      context: {
        source: `- [ ] ${taskText}`,
        fileSource: `- [ ] ${taskText}`,
        taskIndex: 0,
        totalTasks: 1,
        files: [taskFile],
        task,
      },
      execution: {
        mode: "wait",
        verbose: false,
        taskIndex: 0,
        totalTasks: 1,
        keepArtifacts: true,
        printPrompt: false,
        dryRun: false,
        dryRunSuppressesCliExpansion: false,
        cliExpansionEnabled: true,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        forceExecute: false,
        showAgentOutput: false,
        hideHookOutput: false,
        trace: false,
      },
      worker: {
        workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
        loadedWorkerConfig: undefined,
      },
      verifyConfig: {
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        maxRepairAttempts: 0,
        allowRepair: false,
      },
      completion: {
        effectiveRunAll: false,
        commitAfterComplete: false,
        deferCommitUntilPostRun: false,
        commitMessageTemplate: undefined,
        onCompleteCommand: undefined,
        onFailCommand: undefined,
        extraTemplateVars: {},
      },
      prompts: {
        extraTemplateVars: {},
        cliExecutionOptions: undefined,
        cliBlockExecutor: {
          execute: vi.fn(async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          })),
        },
        nowIso: () => "2026-01-01T00:00:00.000Z",
      },
      traceConfig: {
        traceRunSession,
        pendingPreRunResetTraceEvents: [],
        roundContext: {
          currentRound: 1,
          totalRounds: 1,
        },
      },
      lifecycle: {
        failRun: vi.fn(async () => 1),
        finishRun: vi.fn(async () => 0),
        resetArtifacts: vi.fn(),
      },
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, forceRetryableFailure: false });
    expect(events).toContainEqual({ kind: "warn", message: "Fast task has no payload text; skipping." });
    expect(events).toContainEqual({ kind: "group-end", status: "success" });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
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

  async function dispatchControlFlowPrefix(params: {
    prefix: "optional" | "skip" | "end" | "return" | "quit" | "break";
    workerRun: (prompt: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) {
    const task = createTask(path.join(cwd, "tasks.md"), params.prefix + ": there is no output to process");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: [
        "- [ ] " + params.prefix + ": there is no output to process",
        "- [ ] Do this and that",
      ].join("\n"),
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.workerExecutor.runWorker = vi.fn(params.workerRun);

    const tool = resolveBuiltinTool(params.prefix);
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("Expected built-in tool for prefix: " + params.prefix);
    }

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool,
          payload: "there is no output to process",
        },
        remainingText: "there is no output to process",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    return {
      result,
      runWorker: dependencies.workerExecutor.runWorker,
    };
  }

  function createNoopHandlerPrefixChain(payload: string) {
    return {
      modifiers: [],
      handler: {
        tool: {
          name: "question",
          kind: "handler" as const,
          frontmatter: { skipExecution: true, shouldVerify: false },
          handler: async () => ({
            skipExecution: true,
            shouldVerify: false,
          }),
        },
        payload,
      },
      remainingText: payload,
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

  it("routes tool-handler chains before legacy verify-only fallback", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "verify: question: check release notes");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] verify: question: check release notes\n",
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "verify-only",
      prefixChain: createNoopHandlerPrefixChain("check release notes"),
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: { timeoutMs: 25 },
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: undefined,
      toolExpansionInsertedChildCount: undefined,
    });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Verify-only task mode"))).toBe(false);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
  });

  it("routes tool-handler chains before legacy memory-capture fallback", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "memory: question: capture context");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] memory: question: capture context\n",
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "memory-capture",
      memoryCapturePrefix: "memory",
      prefixChain: createNoopHandlerPrefixChain("capture context"),
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: undefined,
      toolExpansionInsertedChildCount: undefined,
    });
    const memoryFilePath = path.join(path.dirname(path.resolve(task.file)), ".rundown", "tasks.md.memory.md");
    expect(fileSystem.exists(memoryFilePath)).toBe(false);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
  });

  it("keeps verify and parallel tool alias handlers behaviorally equivalent", async () => {
    for (const alias of VERIFY_PREFIX_ALIASES) {
      const task = createTask(path.join(cwd, "tasks.md"), `${alias}: check release notes`);
      const fileSystem = createInMemoryFileSystem({
        [task.file]: `- [ ] ${alias}: check release notes\n`,
      });
      const { dependencies, events } = createDependencies({
        cwd,
        task,
        fileSystem,
        gitClient: createGitClientMock(),
      });

      const tool = resolveBuiltinTool(alias);
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("Expected built-in tool for alias: " + alias);
      }

      const result = await dispatchTaskExecution({
        dependencies,
        emit: (event) => events.push(event),
        files: [task.file],
        selectedWorkerCommand: ["opencode", "run"],
        selectedWorkerPattern: {
          command: ["opencode", "run"],
          usesBootstrap: false,
          usesFile: false,
          appendFile: true,
        },
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
        keepArtifacts: true,
        showAgentOutput: false,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        taskIntent: "execute-and-verify",
        prefixChain: {
          modifiers: [],
          handler: {
            tool,
            payload: "check release notes",
          },
          remainingText: "check release notes",
        },
        task,
        prompt: "unused",
        expandedContextBefore: "",
        artifactContext: createArtifactContext(),
        resolvedWorkerCommand: ["opencode", "run"],
        resolvedWorkerPattern: {
          command: ["opencode", "run"],
          usesBootstrap: false,
          usesFile: false,
          appendFile: true,
        },
        trace: false,
        cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
        cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
      });

      expect(result).toEqual({
        kind: "ready-for-completion",
        shouldVerify: true,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
        skipRemainingSiblingsReason: undefined,
        toolExpansionInsertedChildCount: undefined,
      });
      expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
      expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    }

    for (const alias of PARALLEL_PREFIX_ALIASES) {
      const task = createTask(path.join(cwd, "tasks.md"), `${alias}: setup workers`);
      const fileSystem = createInMemoryFileSystem({
        [task.file]: `- [ ] ${alias}: setup workers\n`,
      });
      const { dependencies, events } = createDependencies({
        cwd,
        task,
        fileSystem,
        gitClient: createGitClientMock(),
      });

      const tool = resolveBuiltinTool(alias);
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("Expected built-in tool for alias: " + alias);
      }

      const result = await dispatchTaskExecution({
        dependencies,
        emit: (event) => events.push(event),
        files: [task.file],
        selectedWorkerCommand: ["opencode", "run"],
        selectedWorkerPattern: {
          command: ["opencode", "run"],
          usesBootstrap: false,
          usesFile: false,
          appendFile: true,
        },
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
        keepArtifacts: true,
        showAgentOutput: false,
        ignoreCliBlock: false,
        verify: true,
        noRepair: false,
        repairAttempts: 0,
        taskIntent: "execute-and-verify",
        prefixChain: {
          modifiers: [],
          handler: {
            tool,
            payload: "setup workers",
          },
          remainingText: "setup workers",
        },
        task,
        prompt: "unused",
        expandedContextBefore: "",
        artifactContext: createArtifactContext(),
        resolvedWorkerCommand: ["opencode", "run"],
        resolvedWorkerPattern: {
          command: ["opencode", "run"],
          usesBootstrap: false,
          usesFile: false,
          appendFile: true,
        },
        trace: false,
        cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
        cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
      });

      expect(result).toEqual({
        kind: "ready-for-completion",
        shouldVerify: false,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
        skipRemainingSiblingsReason: undefined,
        toolExpansionInsertedChildCount: undefined,
      });
      expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
      expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    }
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
      executionFailureStdout: "inline out",
      executionFailureStderr: "inline err",
      forceRetryableFailure: true,
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

  it("emits inline cli failure stdout/stderr even when show-agent-output is disabled", async () => {
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
      exitCode: 9,
      stdout: "inline fail out",
      stderr: "inline fail err",
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

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Inline CLI exited with code 9",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 9,
      executionFailureStdout: "inline fail out",
      executionFailureStderr: "inline fail err",
      forceRetryableFailure: true,
    });
    expect(events).toContainEqual({ kind: "text", text: "inline fail out" });
    expect(events).toContainEqual({ kind: "stderr", text: "inline fail err" });
  });

  it("emits inline cli failure stderr when only stderr is present", async () => {
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
      exitCode: 11,
      stdout: "",
      stderr: "inline fail err only",
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

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Inline CLI exited with code 11",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 11,
      executionFailureStdout: "",
      executionFailureStderr: "inline fail err only",
      forceRetryableFailure: true,
    });
    expect(events).toContainEqual({ kind: "stderr", text: "inline fail err only" });
    expect(events.some((event) => event.kind === "text")).toBe(false);
  });

  it("emits inline cli failure stdout when only stdout is present", async () => {
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
      exitCode: 12,
      stdout: "inline fail out only",
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
      executionFailureMessage: "Inline CLI exited with code 12",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 12,
      executionFailureStdout: "inline fail out only",
      executionFailureStderr: "",
      forceRetryableFailure: true,
    });
    expect(events).toContainEqual({ kind: "text", text: "inline fail out only" });
    expect(events.some((event) => event.kind === "stderr")).toBe(false);
  });

  it("keeps generic inline cli failure when both stdout and stderr are empty", async () => {
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
      exitCode: 13,
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

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Inline CLI exited with code 13",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 13,
      executionFailureStdout: "",
      executionFailureStderr: "",
      forceRetryableFailure: true,
    });
    expect(events.some((event) => event.kind === "text" || event.kind === "stderr")).toBe(false);
  });

  it("truncates very large inline cli failure streams while keeping root-cause tail lines visible", async () => {
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
    const hugeStdout = "s".repeat(9_000) + "\n" + "x".repeat(5_500) + "\nroot-cause-stdout\n";
    const hugeStderr = "e".repeat(8_500) + "\n" + "y".repeat(6_500) + "\nroot-cause-stderr\n";

    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 15,
      stdout: hugeStdout,
      stderr: hugeStderr,
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

    expect(result).toEqual({
      kind: "execution-failed",
      executionFailureMessage: "Inline CLI exited with code 15",
      executionFailureRunReason: "Inline CLI exited with a non-zero code.",
      executionFailureExitCode: 15,
      executionFailureStdout: hugeStdout,
      executionFailureStderr: hugeStderr,
      forceRetryableFailure: true,
    });

    const stdoutEvent = events.find((event): event is { kind: "text"; text: string } => event.kind === "text");
    expect(stdoutEvent).toBeDefined();
    expect(stdoutEvent?.text.includes("[Inline CLI stdout truncated: showing first 2000 and last 4000 characters")).toBe(true);
    expect(stdoutEvent?.text.includes("[... omitted ")).toBe(true);
    expect(stdoutEvent?.text.includes("root-cause-stdout")).toBe(true);

    const stderrEvent = events.find((event): event is { kind: "stderr"; text: string } => event.kind === "stderr");
    expect(stderrEvent).toBeDefined();
    expect(stderrEvent?.text.includes("[Inline CLI stderr truncated: showing first 2000 and last 4000 characters")).toBe(true);
    expect(stderrEvent?.text.includes("[... omitted ")).toBe(true);
    expect(stderrEvent?.text.includes("root-cause-stderr")).toBe(true);
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

  it("fails include tool execution on direct self-include cycles", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "include: ./tasks.md");
    const resolvedTaskFile = path.resolve(task.file);
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] include: ./tasks.md\n",
      [resolvedTaskFile]: "- [ ] include: ./tasks.md\n",
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "include",
            kind: "handler",
            handler: includeHandler,
            frontmatter: { skipExecution: true, shouldVerify: false },
          },
          payload: "./tasks.md",
        },
        remainingText: "./tasks.md",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("execution-failed");
    if (result.kind === "execution-failed") {
      expect(result.executionFailureMessage).toContain("Include cycle detected");
      expect(result.executionFailureRunReason).toBe("Include cycle detected (direct self-include).");
      expect(result.executionFailureExitCode).toBe(1);
    }
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
  });

  it("executes include tasks from cloned artifact copies without mutating the source include file", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "include: ./child.md");
    const childFile = path.join(cwd, "child.md");
    const resolvedTaskFile = path.resolve(task.file);
    const resolvedChildFile = path.resolve(childFile);
    const originalChildSource = "- [ ] Ship child\n";
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] include: ./child.md\n",
      [childFile]: originalChildSource,
      [resolvedTaskFile]: "- [ ] include: ./child.md\n",
      [resolvedChildFile]: originalChildSource,
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.executeRundownTask = vi.fn(async (_subcommand, args) => {
      const delegatedFile = args[0];
      if (typeof delegatedFile === "string") {
        const delegatedSource = fileSystem.readText(delegatedFile);
        fileSystem.writeText(delegatedFile, delegatedSource + "- [x] mutated clone only\n");
      }

      return {
        exitCode: 0,
        stdout: "include ok",
        stderr: "",
      };
    });

    const result = await dispatchTaskExecution({
      dependencies,
      emit: (event) => events.push(event),
      files: [task.file],
      selectedWorkerCommand: ["opencode", "run"],
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "include",
            kind: "handler",
            handler: includeHandler,
            frontmatter: { skipExecution: true, shouldVerify: false },
          },
          payload: "./child.md",
        },
        remainingText: "./child.md",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(dependencies.workerExecutor.executeRundownTask).toHaveBeenCalledTimes(1);
    const executeCallArgs = vi.mocked(dependencies.workerExecutor.executeRundownTask).mock.calls[0];
    const delegatedRunArgs = executeCallArgs[1];
    const clonedIncludePath = delegatedRunArgs[0];
    expect((clonedIncludePath as string).split("\\").join("/"))
      .toContain("/workspace/.rundown/runs/run-dispatch/includes/");
    expect(clonedIncludePath).not.toBe(resolvedChildFile);
    expect(fileSystem.readText(clonedIncludePath as string)).toContain("mutated clone only");
    expect(fileSystem.readText(resolvedChildFile)).toBe(originalChildSource);
  });

  it("fails include tool execution on indirect include cycles from include stack", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "include: ./child.md");
    const childFile = path.join(cwd, "child.md");
    const resolvedTaskFile = path.resolve(task.file);
    const resolvedChildFile = path.resolve(childFile);
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] include: ./child.md\n",
      [childFile]: "- [ ] Ship child\n",
      [resolvedTaskFile]: "- [ ] include: ./child.md\n",
      [resolvedChildFile]: "- [ ] Ship child\n",
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "include",
            kind: "handler",
            handler: includeHandler,
            frontmatter: { skipExecution: true, shouldVerify: false },
          },
          payload: "./child.md",
        },
        remainingText: "./child.md",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      executionEnv: {
        RUNDOWN_INCLUDE_STACK: JSON.stringify([resolvedChildFile]),
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("execution-failed");
    if (result.kind === "execution-failed") {
      expect(result.executionFailureMessage).toContain("Include cycle detected");
      expect(result.executionFailureRunReason).toBe("Include cycle detected (indirect recursion).");
      expect(result.executionFailureExitCode).toBe(1);
    }
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
  });

  it("fails include tool execution when current file already appears in include stack", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "include: ./child.md");
    const childFile = path.join(cwd, "child.md");
    const resolvedTaskFile = path.resolve(task.file);
    const resolvedChildFile = path.resolve(childFile);
    const parentFile = path.join(cwd, "parent.md");
    const resolvedParentFile = path.resolve(parentFile);
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] include: ./child.md\n",
      [childFile]: "- [ ] Ship child\n",
      [parentFile]: "- [ ] include: ./tasks.md\n",
      [resolvedTaskFile]: "- [ ] include: ./child.md\n",
      [resolvedChildFile]: "- [ ] Ship child\n",
      [resolvedParentFile]: "- [ ] include: ./tasks.md\n",
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "include",
            kind: "handler",
            handler: includeHandler,
            frontmatter: { skipExecution: true, shouldVerify: false },
          },
          payload: "./child.md",
        },
        remainingText: "./child.md",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      executionEnv: {
        RUNDOWN_INCLUDE_STACK: JSON.stringify([resolvedParentFile, resolvedTaskFile]),
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("execution-failed");
    if (result.kind === "execution-failed") {
      expect(result.executionFailureMessage).toContain("Include cycle detected");
      expect(result.executionFailureRunReason).toBe("Include cycle detected (indirect recursion).");
      expect(result.executionFailureExitCode).toBe(1);
    }
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
  });

  it("maps tool handler skipRemainingSiblings into dispatch completion result", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "end: no output to process");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] end: no output to process\n- [ ] Do this and that\n",
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "end",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async () => ({
              skipExecution: true,
              shouldVerify: true,
              skipRemainingSiblings: { reason: "no output to process" },
            }),
          },
          payload: "no output to process",
        },
        remainingText: "no output to process",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: "no output to process",
      toolExpansionInsertedChildCount: undefined,
    });
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it.each(["optional", "skip", "end", "return", "quit", "break"] as const)(
    "keeps control-flow outcomes for %s: true/false/ambiguous/error",
    async (prefix) => {
      const yesOutcome = await dispatchControlFlowPrefix({
        prefix,
        workerRun: async () => ({ exitCode: 0, stdout: "yes", stderr: "" }),
      });
      expect(yesOutcome.result).toEqual({
        kind: "ready-for-completion",
        shouldVerify: false,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
        skipRemainingSiblingsReason: "there is no output to process",
        toolExpansionInsertedChildCount: undefined,
      });
      expect(yesOutcome.runWorker).toHaveBeenCalledTimes(1);

      const noOutcome = await dispatchControlFlowPrefix({
        prefix,
        workerRun: async () => ({ exitCode: 0, stdout: "no", stderr: "" }),
      });
      expect(noOutcome.result).toEqual({
        kind: "ready-for-completion",
        shouldVerify: false,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
        skipRemainingSiblingsReason: undefined,
        toolExpansionInsertedChildCount: undefined,
      });
      expect(noOutcome.runWorker).toHaveBeenCalledTimes(1);

      const ambiguousOutcome = await dispatchControlFlowPrefix({
        prefix,
        workerRun: async () => ({ exitCode: 0, stdout: "maybe", stderr: "" }),
      });
      expect(ambiguousOutcome.result).toEqual({
        kind: "ready-for-completion",
        shouldVerify: false,
        cliExecutionOptionsForVerification: undefined,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
        skipRemainingSiblingsReason: undefined,
        toolExpansionInsertedChildCount: undefined,
      });
      expect(ambiguousOutcome.runWorker).toHaveBeenCalledTimes(1);

      const errorOutcome = await dispatchControlFlowPrefix({
        prefix,
        workerRun: async () => {
          throw new Error("worker unavailable");
        },
      });
      expect(errorOutcome.result).toEqual({
        kind: "execution-failed",
        executionFailureMessage: "Failed to evaluate end condition: worker unavailable",
        executionFailureRunReason: "End condition worker invocation failed.",
        executionFailureExitCode: 1,
      });
      expect(errorOutcome.runWorker).toHaveBeenCalledTimes(1);
    },
  );

  it("advances for-loop metadata and returns transition details for loop handlers", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "for: This, That", {
      subItems: [
        { text: "for-item: This", line: 2, depth: 1 },
        { text: "for-item: That", line: 3, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 4,
          depth: 1,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [task.file]: [
        "- [ ] for: This, That",
        "  - for-item: This",
        "  - for-item: That",
        "  - [ ] Do this",
      ].join("\n"),
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "for",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async () => ({
              skipExecution: true,
              shouldVerify: false,
            }),
          },
          payload: "This, That",
        },
        remainingText: "This, That",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: undefined,
      toolExpansionInsertedChildCount: undefined,
      forLoopAdvanced: {
        current: "This",
        remainingItems: 1,
      },
    });

    expect(fileSystem.readText(task.file)).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: This",
      "  - [ ] Do this",
    ].join("\n"));
  });

  it("syncs canonical loop metadata before advancing cursor", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "for: This, That", {
      subItems: [
        { text: "for-item: Legacy", line: 2, depth: 1 },
        { text: "for-current: Legacy", line: 3, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 4,
          depth: 1,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [task.file]: [
        "- [ ] for: This, That",
        "  - for-item: Legacy",
        "  - for-current: Legacy",
        "  - [ ] Do this",
      ].join("\n"),
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "for",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async () => ({
              skipExecution: true,
              shouldVerify: false,
              forLoopItems: ["This", "That"],
            }),
          },
          payload: "This, That",
        },
        remainingText: "This, That",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: undefined,
      toolExpansionInsertedChildCount: undefined,
      forLoopAdvanced: {
        current: "This",
        remainingItems: 1,
      },
      forLoopItems: ["This", "That"],
    });

    expect(fileSystem.readText(task.file)).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: This",
      "  - [ ] Do this",
    ].join("\n"));
  });

  it("signals loop completion after final item and clears for-current metadata", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "for: This, That", {
      subItems: [
        { text: "for-item: This", line: 2, depth: 1 },
        { text: "for-item: That", line: 3, depth: 1 },
        { text: "for-current: That", line: 4, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 5,
          depth: 1,
          checked: true,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [task.file]: [
        "- [ ] for: This, That",
        "  - for-item: This",
        "  - for-item: That",
        "  - for-current: That",
        "  - [x] Do this",
      ].join("\n"),
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
      selectedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
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
      keepArtifacts: true,
      showAgentOutput: false,
      ignoreCliBlock: false,
      verify: true,
      noRepair: false,
      repairAttempts: 0,
      taskIntent: "execute-and-verify",
      prefixChain: {
        modifiers: [],
        handler: {
          tool: {
            name: "for",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async () => ({
              skipExecution: true,
              shouldVerify: false,
              forLoopItems: ["This", "That"],
            }),
          },
          payload: "This, That",
        },
        remainingText: "This, That",
      },
      task,
      prompt: "unused",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      resolvedWorkerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      trace: false,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      skipRemainingSiblingsReason: undefined,
      toolExpansionInsertedChildCount: undefined,
      forLoopCompleted: true,
      forLoopItems: ["This", "That"],
    });

    expect(fileSystem.readText(task.file)).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - [x] Do this",
    ].join("\n"));
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
    expect(events.some((event) => event.kind === "info" && event.message.includes("opencode run [wait]"))).toBe(true);
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
      executionStdout: "done",
      executionOutputCaptured: true,
      cliExecutionOptionsForVerification: verifyAfterExecuteOptions,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    });
  });

  it("omits execution stdout capture when shouldVerify is false", async () => {
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
      stdout: "provider limit message",
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
      shouldVerify: false,
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

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
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
      executionFailureStdout: "",
      executionFailureStderr: "worker failed",
      forceRetryableFailure: true,
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
      executionFailureStdout: "",
      executionFailureStderr: "inline failed",
      forceRetryableFailure: true,
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
      originTask: {
        text: task.text,
        line: task.line,
      },
    });
  });

  it("keeps memory capture prefix aliases behaviorally equivalent for persistence", async () => {
    for (const alias of MEMORY_PREFIX_ALIASES) {
      const task = createTask(path.join(cwd, "tasks.md"), `${alias}: capture release memory`);
      const fileSystem = createInMemoryFileSystem({
        [task.file]: `- [ ] ${alias}: capture release memory\n`,
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
        memoryCapturePrefix: alias,
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
        capturePrefix: alias,
        originTask: {
          text: task.text,
          line: task.line,
        },
      });
    }
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
      forceRetryableFailure: true,
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
      forceRetryableFailure: true,
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

  it("expands tool tasks into child TODO items and disables verification", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "post-on-gitea: report auth issue");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] post-on-gitea: report auth issue\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: vi.fn(() => ({
        name: "post-on-gitea",
        templatePath: path.join(cwd, ".rundown", "tools", "post-on-gitea.md"),
        template: "Request: {{payload}}\nFile: {{file}}\nContext:\n{{context}}",
      })),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "- [ ] Draft issue details\n- [ ] Create gitea issue",
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
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
      toolPayload: "report auth issue",
      task,
      prompt: "unused prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      toolExpansionInsertedChildCount: 2,
    });
    expect(dependencies.toolResolver.resolve).toHaveBeenCalledWith("post-on-gitea");
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Request: report auth issue\nFile: " + task.file + "\nContext:\n",
    }));
    expect(fileSystem.readText(task.file)).toContain("  - [ ] Draft issue details");
    expect(fileSystem.readText(task.file)).toContain("  - [ ] Create gitea issue");
  });

  it("inserts only unchecked TODO lines parsed from tool worker output", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "summarize: auth issue context");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] summarize: auth issue context\n- [ ] Follow-up task\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: vi.fn(() => ({
        name: "summarize",
        templatePath: path.join(cwd, ".rundown", "tools", "summarize.md"),
        template: "Request: {{payload}}",
      })),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "Here is the plan:",
        "- [x] Already complete",
        "- plain bullet",
        "- [ ] Draft auth summary",
        "* [ ] Post issue update",
        "+ [ ] Confirm assignee",
      ].join("\n"),
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
      taskIntent: "tool-expansion",
      toolName: "summarize",
      toolPayload: "auth issue context",
      task,
      prompt: "unused prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result).toEqual({
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: undefined,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      toolExpansionInsertedChildCount: 3,
    });
    expect(fileSystem.readText(task.file)).toBe([
      "- [ ] summarize: auth issue context",
      "  - [ ] Draft auth summary",
      "  - [ ] Post issue update",
      "  - [ ] Confirm assignee",
      "- [ ] Follow-up task",
      "",
    ].join("\n"));
  });

  it("inserts tool-generated TODOs with nested indentation under nested parent task", async () => {
    const task = {
      ...createTask(path.join(cwd, "tasks.md"), "summarize: nested auth issue"),
      line: 2,
      depth: 1,
    };
    const fileSystem = createInMemoryFileSystem({
      [task.file]: [
        "- [ ] Parent",
        "  - [ ] summarize: nested auth issue",
        "  - [ ] Existing nested task",
      ].join("\n"),
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: vi.fn(() => ({
        name: "summarize",
        templatePath: path.join(cwd, ".rundown", "tools", "summarize.md"),
        template: "Request: {{payload}}",
      })),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "- [ ] Inserted nested task",
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
      taskIntent: "tool-expansion",
      toolName: "summarize",
      toolPayload: "nested auth issue",
      task,
      prompt: "unused prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    expect(fileSystem.readText(task.file)).toBe([
      "- [ ] Parent",
      "  - [ ] summarize: nested auth issue",
      "    - [ ] Inserted nested task",
      "  - [ ] Existing nested task",
    ].join("\n"));
  });

  it("completes tool tasks with no child TODO output", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "summarize: auth issue context");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] summarize: auth issue context\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: vi.fn(() => ({
        name: "summarize",
        templatePath: path.join(cwd, ".rundown", "tools", "summarize.md"),
        template: "Request: {{payload}}",
      })),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "No tasks needed",
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
      taskIntent: "tool-expansion",
      toolName: "summarize",
      toolPayload: "auth issue context",
      task,
      prompt: "unused prompt",
      expandedContextBefore: "",
      artifactContext: createArtifactContext(),
      resolvedWorkerCommand: ["opencode", "run"],
      trace: true,
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: undefined,
    });

    expect(result.kind).toBe("ready-for-completion");
    if (result.kind === "ready-for-completion") {
      expect(result.shouldVerify).toBe(false);
    }
    expect(fileSystem.readText(task.file)).toBe("- [ ] summarize: auth issue context\n");
  });

  it("rejects detached mode for tool-expansion tasks", async () => {
    const task = createTask(path.join(cwd, "tasks.md"), "summarize: auth issue context");
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] summarize: auth issue context\n",
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
      taskIntent: "tool-expansion",
      toolName: "summarize",
      toolPayload: "auth issue context",
      task,
      prompt: "unused prompt",
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
        "Tool expansion tasks do not support detached mode because worker output is required for TODO insertion.",
      executionFailureRunReason: "Tool expansion task cannot insert children in detached mode.",
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
      setVerificationEfficiency: vi.fn(),
      collectStatistics: vi.fn(() => null),
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
    const afterTaskFailedSpy = vi.spyOn(runLifecycleModule, "afterTaskFailed").mockResolvedValue();
    const writeFixAnnotationSpy = vi
      .spyOn(checkboxOperationsModule, "writeFixAnnotationToFile")
      .mockImplementation(() => {});

    vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop").mockResolvedValue({
      valid: false,
      failureReason: "missing tests",
    });
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({
      continueLoop: false,
      exitCode: 2,
      forceRetryableFailure: true,
      groupEnded: false,
      failureMessage: "Verification failed. Task not checked.\nmissing tests",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Verification failed. Task not checked.\nmissing tests",
    });
    expect(writeFixAnnotationSpy).toHaveBeenCalledWith(task, "missing tests", dependencies.fileSystem);
    expect(afterTaskFailedSpy).toHaveBeenCalledWith(
      dependencies,
      task,
      "- [ ] Ship release",
      undefined,
      false,
      {},
    );
    expect(writeFixAnnotationSpy.mock.invocationCallOrder[0]).toBeLessThan(afterTaskFailedSpy.mock.invocationCallOrder[0] ?? 0);
    expect(afterTaskFailedSpy.mock.invocationCallOrder[0]).toBeLessThan(failRun.mock.invocationCallOrder[0] ?? 0);
    expect(failRun).toHaveBeenCalledWith(2, "verification-failed", "verification-failed", 2);
  });

  it("emits a warning and still fails the run when writing fix annotation throws", async () => {
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
    const afterTaskFailedSpy = vi.spyOn(runLifecycleModule, "afterTaskFailed").mockResolvedValue();

    vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop").mockResolvedValue({
      valid: false,
      failureReason: "missing tests",
    });
    vi
      .spyOn(checkboxOperationsModule, "writeFixAnnotationToFile")
      .mockImplementation(() => {
        throw new Error("simulated file I/O error");
      });
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
      trace: false,
      verbose: false,
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: true,
      runMode: "wait",
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({
      continueLoop: false,
      exitCode: 2,
      forceRetryableFailure: true,
      groupEnded: false,
      failureMessage: "Verification failed. Task not checked.\nmissing tests",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Failed to write verification fix annotation: Error: simulated file I/O error",
    });
    expect(afterTaskFailedSpy).toHaveBeenCalledWith(
      dependencies,
      task,
      "- [ ] Ship release",
      undefined,
      false,
      {},
    );
    expect(failRun).toHaveBeenCalledWith(2, "verification-failed", "verification-failed", 2);
    expect(afterTaskFailedSpy.mock.invocationCallOrder[0]).toBeLessThan(failRun.mock.invocationCallOrder[0] ?? 0);
  });

  it("returns exit code 2 when resolve outcome is unresolved", async () => {
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
    vi.spyOn(runLifecycleModule, "afterTaskFailed").mockResolvedValue();
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});
    vi.spyOn(checkboxOperationsModule, "writeFixAnnotationToFile").mockImplementation(() => {});
    vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop").mockResolvedValue({
      valid: false,
      failureReason: "Resolve phase could not diagnose the issue: contradictory repair outputs.",
    });

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
      maxRepairAttempts: 2,
      maxResolveRepairAttempts: 1,
      allowRepair: true,
      trace: false,
      verbose: false,
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
        resolve: "{{task}}",
        plan: "",
        trace: "",
      },
      templateVarsWithTrace: {},
      automationCommand: ["opencode", "run"],
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: true,
      runMode: "wait",
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
      verificationFailureRunReason: "verification-failed",
      extraTemplateVars: {},
    });

    expect(result.exitCode).toBe(2);
    expect(failRun).toHaveBeenCalledWith(2, "verification-failed", "verification-failed", 2);
  });

  it("returns exit code 2 when resolve-informed repairs are exhausted", async () => {
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
    vi.spyOn(runLifecycleModule, "afterTaskFailed").mockResolvedValue();
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});
    vi.spyOn(checkboxOperationsModule, "writeFixAnnotationToFile").mockImplementation(() => {});
    vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop").mockResolvedValue({
      valid: false,
      failureReason: "Resolve-informed repair attempts exhausted after 1 attempt(s).",
    });

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
      maxRepairAttempts: 2,
      maxResolveRepairAttempts: 1,
      allowRepair: true,
      trace: false,
      verbose: false,
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
        resolve: "{{task}}",
        plan: "",
        trace: "",
      },
      templateVarsWithTrace: {},
      automationCommand: ["opencode", "run"],
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: true,
      runMode: "wait",
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
      verificationFailureRunReason: "verification-failed",
      extraTemplateVars: {},
    });

    expect(result.exitCode).toBe(2);
    expect(failRun).toHaveBeenCalledWith(2, "verification-failed", "verification-failed", 2);
  });

  it("stacks fix annotations across consecutive verification failures without checkbox reset", async () => {
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
    vi.spyOn(runLifecycleModule, "afterTaskFailed").mockResolvedValue();
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});

    const verifySpy = vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop");
    verifySpy
      .mockResolvedValueOnce({ valid: false, failureReason: "first failure" })
      .mockResolvedValueOnce({ valid: false, failureReason: "second failure" });

    const createParams = () => ({
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
      trace: false,
      verbose: false,
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: true,
      runMode: "wait" as const,
      verificationPrompt: "verify",
      artifactContext: {
        runId: "run-complete",
        rootDir: path.join(cwd, ".rundown", "runs", "run-complete"),
        cwd,
        keepArtifacts: true,
        commandName: "run" as const,
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      verificationFailureMessage: "Verification failed. Task not checked.",
      verificationFailureRunReason: "verification-failed",
      extraTemplateVars: {},
    });

    const firstResult = await completeTaskIteration(createParams());
    expect(firstResult.exitCode).toBe(2);
    expect(fileSystem.readText(task.file)).toBe([
      "- [x] Ship release",
      "  - fix: first failure",
      "",
    ].join("\n"));

    const secondResult = await completeTaskIteration(createParams());
    expect(secondResult.exitCode).toBe(2);
    expect(fileSystem.readText(task.file)).toBe([
      "- [x] Ship release",
      "  - fix: second failure",
      "  - fix: first failure",
      "",
    ].join("\n"));
  });

  it("uses research-repair template for inline rundown research tasks", async () => {
    const inlineResearchTask = createInlineTask(
      task.file,
      "cli: rundown research \"38. Fix output for every command.md\"",
    );
    const fileSystem = createInMemoryFileSystem({
      [inlineResearchTask.file]: "- [ ] cli: rundown research \"38. Fix output for every command.md\"\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: inlineResearchTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.templateLoader.load = vi.fn((templatePath: string) => {
      if (templatePath.endsWith("research-repair.md")) {
        return "RESEARCH REPAIR TEMPLATE";
      }
      return null;
    });

    const runVerifyRepairLoopSpy = vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop").mockResolvedValue({
      valid: true,
      failureReason: null,
    });
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state: {
        traceWriter: dependencies.traceWriter,
        deferredCommitContext: null,
        tasksCompleted: 0,
        runCompleted: false,
      },
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
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
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: inlineResearchTask,
      sourceText: "- [ ] cli: rundown research \"38. Fix output for every command.md\"",
      expandedSource: "- [ ] cli: rundown research \"38. Fix output for every command.md\"",
      expandedContextBefore: "",
      templates: {
        task: "",
        discuss: "",
        research: "",
        verify: "{{task}}",
        repair: "DEFAULT REPAIR TEMPLATE",
        plan: "",
        trace: "",
      },
      templateVarsWithTrace: {},
      automationCommand: ["opencode", "run"],
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: true,
      runMode: "wait",
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(runVerifyRepairLoopSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repairTemplate: "RESEARCH REPAIR TEMPLATE",
        targetArtifactPath: path.resolve(path.dirname(inlineResearchTask.file), "38. Fix output for every command.md"),
        targetArtifactPathDisplay: "38. Fix output for every command.md",
        controllingTaskPath: path.resolve(inlineResearchTask.file),
        controllingTaskPathDisplay: path.basename(inlineResearchTask.file),
        controllingTaskFile: inlineResearchTask.file,
        selectedTaskMetadata: expect.any(String),
      }),
    );

    const verifyLoopInput = runVerifyRepairLoopSpy.mock.calls[0]?.[1];
    const selectedTaskMetadata = typeof verifyLoopInput?.selectedTaskMetadata === "string"
      ? JSON.parse(verifyLoopInput.selectedTaskMetadata) as Record<string, unknown>
      : null;
    expect(selectedTaskMetadata).toMatchObject({
      text: inlineResearchTask.text,
      index: inlineResearchTask.index,
      line: inlineResearchTask.line,
      file: inlineResearchTask.file,
      controllingTaskPath: path.resolve(inlineResearchTask.file),
      isInlineCli: true,
      cliCommand: inlineResearchTask.cliCommand,
    });
  });

  it("skips usage-limit detection entirely when shouldVerify is false", async () => {
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
    const verifyRepairLoopSpy = vi.spyOn(verifyRepairLoopModule, "runVerifyRepairLoop");
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
      failRun: vi.fn(async () => 2),
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
      trace: true,
      verbose: false,
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
      executionOutputCaptured: true,
      verificationPrompt: "verify",
      executionStdout: "HTTP 429 Too Many Requests: billing quota reached",
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(verifyRepairLoopSpy).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("Possible API usage limit detected"),
    }));
  });

  it("keeps per-task commit immediate when commit is enabled without deferral", async () => {
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

    const afterTaskCompleteSpy = vi.spyOn(runLifecycleModule, "afterTaskComplete").mockResolvedValue({ commit: "ok" });
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});
    const finishRun = vi.fn(async () => 0);

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun,
      resetArtifacts: vi.fn(),
      keepArtifacts: true,
      effectiveRunAll: false,
      commitAfterComplete: true,
      deferCommitUntilPostRun: false,
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(state.deferredCommitContext).toBeNull();
    expect(afterTaskCompleteSpy).toHaveBeenCalledWith(
      dependencies,
      task,
      "- [ ] Ship release",
      true,
      "done: {{task}}",
      undefined,
      false,
      {},
      false,
    );
    expect(finishRun).toHaveBeenCalledWith(0, "completed", true, undefined, { commit: "ok" });
  });

  it("does not queue deferred commit context when commit is disabled", async () => {
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

    const afterTaskCompleteSpy = vi.spyOn(runLifecycleModule, "afterTaskComplete").mockResolvedValue({});
    vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun: vi.fn(async () => 0),
      resetArtifacts: vi.fn(),
      keepArtifacts: true,
      effectiveRunAll: true,
      commitAfterComplete: false,
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: true, groupEnded: true });
    expect(state.deferredCommitContext).toBeNull();
    expect(afterTaskCompleteSpy).toHaveBeenCalledWith(
      dependencies,
      task,
      "- [ ] Ship release",
      false,
      "done: {{task}}",
      undefined,
      false,
      {},
      false,
    );
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

    const afterTaskCompleteSpy = vi.spyOn(runLifecycleModule, "afterTaskComplete").mockResolvedValue({ commit: "ok" });
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: true, groupEnded: true });
    expect(state.tasksCompleted).toBe(1);
    expect(state.deferredCommitContext).toEqual({
      task,
      source: "- [ ] Ship release\n",
      artifactContext: {
        runId: "run-complete",
        rootDir: path.join(cwd, ".rundown", "runs", "run-complete"),
        cwd,
        keepArtifacts: true,
        commandName: "run",
      },
    });
    expect(afterTaskCompleteSpy).toHaveBeenCalledWith(
      dependencies,
      task,
      "- [ ] Ship release",
      false,
      "done: {{task}}",
      undefined,
      false,
      {},
      false,
    );
    expect(finishRun).toHaveBeenCalledWith(0, "completed", true, undefined, { commit: "ok" });
    expect(resetArtifacts).toHaveBeenCalledTimes(1);
  });

  it("continues loop after checking tool task when children were inserted", async () => {
    const fileSystem = createInMemoryFileSystem({
      [task.file]: "- [ ] post-on-gitea: report auth issue\n  - [ ] Draft issue details\n",
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

    const afterTaskCompleteSpy = vi.spyOn(runLifecycleModule, "afterTaskComplete").mockResolvedValue({});
    const checkTaskSpy = vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem").mockImplementation(() => {});
    const insertStatisticsSpy = vi.spyOn(checkboxOperationsModule, "insertTraceStatisticsUsingFileSystem");
    const finishRun = vi.fn(async () => 0);
    const resetArtifacts = vi.fn();
    const traceRunSession = {
      collectStatistics: vi.fn(() => ({
        fields: {
          total_time: 5_100,
          execution_time: 2_000,
          verify_time: 0,
          repair_time: 0,
          idle_time: 0,
          tokens_estimated: 42,
          phases_count: 1,
          verify_attempts: 0,
          repair_attempts: 0,
        },
      })),
    } as unknown as ReturnType<typeof createTraceRunSession>;

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession,
      failRun: vi.fn(async () => 1),
      finishRun,
      resetArtifacts,
      keepArtifacts: true,
      effectiveRunAll: false,
      commitAfterComplete: true,
      deferCommitUntilPostRun: false,
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
      sourceText: "- [ ] post-on-gitea: report auth issue",
      expandedSource: "- [ ] post-on-gitea: report auth issue",
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
      toolExpansionInsertedChildCount: 1,
      extraTemplateVars: {},
      traceStatisticsConfig: {
        enabled: true,
        fields: ["total_time", "execution_time", "tokens_estimated"],
      },
    });

    expect(result).toEqual({ continueLoop: true, groupEnded: true });
    expect(state.tasksCompleted).toBe(1);
    expect(checkTaskSpy).toHaveBeenCalledTimes(1);
    expect(traceRunSession.collectStatistics).not.toHaveBeenCalled();
    expect(insertStatisticsSpy).not.toHaveBeenCalled();
    expect(afterTaskCompleteSpy).not.toHaveBeenCalled();
    expect(finishRun).not.toHaveBeenCalled();
    expect(resetArtifacts).toHaveBeenCalledTimes(1);
  });

  it("advances loop metadata and keeps parent unchecked while iterations remain", async () => {
    const loopTask = createTask(path.join(cwd, "tasks.md"), "for: Alpha, Beta", {
      subItems: [
        { text: "for-item: Alpha", line: 2, depth: 1 },
        { text: "for-item: Beta", line: 3, depth: 1 },
        { text: "for-current: Alpha", line: 4, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 5,
          depth: 1,
          checked: true,
        }),
        createTask(path.join(cwd, "tasks.md"), "Do that", {
          index: 2,
          line: 6,
          depth: 1,
          checked: true,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [loopTask.file]: [
        "- [ ] for: Alpha, Beta",
        "  - for-item: Alpha",
        "  - for-item: Beta",
        "  - for-current: Alpha",
        "  - [x] Do this",
        "  - [x] Do that",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: loopTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const state = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };
    const checkTaskSpy = vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem");
    const resetArtifacts = vi.fn();
    const emit = vi.fn();

    const result = await completeTaskIteration({
      dependencies,
      emit,
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun: vi.fn(async () => 0),
      resetArtifacts,
      keepArtifacts: true,
      effectiveRunAll: true,
      commitAfterComplete: false,
      deferCommitUntilPostRun: false,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
      onFailCommand: undefined,
      hideHookOutput: false,
      maxRepairAttempts: 1,
      allowRepair: true,
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: loopTask,
      sourceText: fileSystem.readText(loopTask.file),
      expandedSource: fileSystem.readText(loopTask.file),
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: true, groupEnded: false });
    expect(checkTaskSpy).not.toHaveBeenCalled();
    expect(resetArtifacts).toHaveBeenCalledTimes(1);
    expect(state.tasksCompleted).toBe(1);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Loop item completed: Alpha.",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Loop advanced to item: Beta (0 remaining).",
    });
    expect(fileSystem.readText(loopTask.file)).toBe([
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "",
    ].join("\n"));
  });

  it("keeps loop parent unchecked when dispatch signals advance for stripped task text", async () => {
    const loopTask = createTask(path.join(cwd, "tasks.md"), "Alpha, Beta", {
      line: 1,
      index: 0,
    });
    const fileSystem = createInMemoryFileSystem({
      [loopTask.file]: [
        "- [ ] for: Alpha, Beta",
        "  - for-item: Alpha",
        "  - for-item: Beta",
        "  - for-current: Alpha",
        "  - [x] Do this",
        "  - [x] Do that",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: loopTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const state = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };
    const resetArtifacts = vi.fn();
    const checkTaskSpy = vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem");

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun: vi.fn(async () => 0),
      resetArtifacts,
      keepArtifacts: true,
      effectiveRunAll: true,
      commitAfterComplete: false,
      deferCommitUntilPostRun: false,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
      onFailCommand: undefined,
      hideHookOutput: false,
      maxRepairAttempts: 1,
      allowRepair: true,
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: loopTask,
      sourceText: fileSystem.readText(loopTask.file),
      expandedSource: fileSystem.readText(loopTask.file),
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
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
      forLoopAdvanced: {
        current: "Beta",
        remainingItems: 0,
      },
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: true, groupEnded: false });
    expect(checkTaskSpy).not.toHaveBeenCalled();
    expect(resetArtifacts).toHaveBeenCalledTimes(1);
    expect(state.tasksCompleted).toBe(1);
    expect(fileSystem.readText(loopTask.file).split("\n")[0]).toBe("- [ ] for: Alpha, Beta");
  });

  it("completes loop parent after final iteration and clears for-current", async () => {
    const loopTask = createTask(path.join(cwd, "tasks.md"), "for: Alpha, Beta", {
      subItems: [
        { text: "for-item: Alpha", line: 2, depth: 1 },
        { text: "for-item: Beta", line: 3, depth: 1 },
        { text: "for-current: Beta", line: 4, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 5,
          depth: 1,
          checked: true,
        }),
        createTask(path.join(cwd, "tasks.md"), "Do that", {
          index: 2,
          line: 6,
          depth: 1,
          checked: true,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [loopTask.file]: [
        "- [ ] for: Alpha, Beta",
        "  - for-item: Alpha",
        "  - for-item: Beta",
        "  - for-current: Beta",
        "  - [x] Do this",
        "  - [x] Do that",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: loopTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const state = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };
    const finishRun = vi.fn(async () => 0);
    const resetArtifacts = vi.fn();
    const emit = vi.fn();

    const result = await completeTaskIteration({
      dependencies,
      emit,
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun,
      resetArtifacts,
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
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: loopTask,
      sourceText: fileSystem.readText(loopTask.file),
      expandedSource: fileSystem.readText(loopTask.file),
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
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
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(finishRun).toHaveBeenCalledWith(0, "completed", true, undefined, undefined);
    expect(resetArtifacts).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Loop item completed: Beta.",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Loop completed after 2 items; marking parent task complete.",
    });
    expect(fileSystem.readText(loopTask.file)).toBe([
      "- [x] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - [x] Do this",
      "  - [x] Do that",
      "",
    ].join("\n"));
  });

  it("completes loop parent deterministically when dispatch already finalized for-current", async () => {
    const loopTask = createTask(path.join(cwd, "tasks.md"), "for: Alpha, Beta", {
      subItems: [
        { text: "for-item: Alpha", line: 2, depth: 1 },
        { text: "for-item: Beta", line: 3, depth: 1 },
        { text: "for-current: Beta", line: 4, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 4,
          depth: 1,
          checked: true,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [loopTask.file]: [
        "- [ ] for: Alpha, Beta",
        "  - for-item: Alpha",
        "  - for-item: Beta",
        "  - [x] Do this",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: loopTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const state = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };
    const finishRun = vi.fn(async () => 0);
    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun,
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
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: loopTask,
      sourceText: fileSystem.readText(loopTask.file),
      expandedSource: fileSystem.readText(loopTask.file),
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
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
      forLoopCompleted: true,
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(finishRun).toHaveBeenCalledWith(0, "completed", true, undefined, undefined);
    expect(fileSystem.readText(loopTask.file)).toBe([
      "- [x] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - [x] Do this",
      "",
    ].join("\n"));
  });

  it("resumes loop completion from persisted for-current cursor after interruption", async () => {
    const loopTask = createTask(path.join(cwd, "tasks.md"), "for: Alpha, Beta", {
      subItems: [
        { text: "for-item: Alpha", line: 2, depth: 1 },
        { text: "for-item: Beta", line: 3, depth: 1 },
        { text: "for-current: Alpha", line: 4, depth: 1 },
      ],
      children: [
        createTask(path.join(cwd, "tasks.md"), "Do this", {
          index: 1,
          line: 5,
          depth: 1,
          checked: true,
        }),
        createTask(path.join(cwd, "tasks.md"), "Do that", {
          index: 2,
          line: 6,
          depth: 1,
          checked: true,
        }),
      ],
    });
    const fileSystem = createInMemoryFileSystem({
      [loopTask.file]: [
        "- [ ] for: Alpha, Beta",
        "  - for-item: Alpha",
        "  - for-item: Beta",
        "  - for-current: Alpha",
        "  - [x] Do this",
        "  - [x] Do that",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: loopTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    const firstPassState = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };

    const firstPassResult = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state: firstPassState,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun: vi.fn(async () => 0),
      resetArtifacts: vi.fn(),
      keepArtifacts: true,
      effectiveRunAll: true,
      commitAfterComplete: false,
      deferCommitUntilPostRun: false,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
      onFailCommand: undefined,
      hideHookOutput: false,
      maxRepairAttempts: 1,
      allowRepair: true,
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: loopTask,
      sourceText: fileSystem.readText(loopTask.file),
      expandedSource: fileSystem.readText(loopTask.file),
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
      verificationPrompt: "",
      artifactContext: {
        runId: "run-pass-1",
        rootDir: path.join(cwd, ".rundown", "runs", "run-pass-1"),
        cwd,
        keepArtifacts: true,
        commandName: "run",
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      verificationFailureMessage: "unused",
      verificationFailureRunReason: "unused",
      extraTemplateVars: {},
    });

    expect(firstPassResult).toEqual({ continueLoop: true, groupEnded: false });
    expect(fileSystem.readText(loopTask.file)).toBe([
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "",
    ].join("\n"));

    // Simulate an interrupted process: file persists cursor+metadata, then the next
    // run resumes and finishes child work for the current item before completion.
    fileSystem.writeText(loopTask.file, [
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "  - [x] Do this",
      "  - [x] Do that",
      "",
    ].join("\n"));

    const latestAfterResume = parseTasks(fileSystem.readText(loopTask.file), loopTask.file);
    const resumedLoopTask = latestAfterResume.find((candidate) => candidate.text === "for: Alpha, Beta");
    expect(resumedLoopTask).toBeDefined();

    const resumeState = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };

    const resumedResult = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state: resumeState,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun: vi.fn(async () => 0),
      resetArtifacts: vi.fn(),
      keepArtifacts: true,
      effectiveRunAll: true,
      commitAfterComplete: false,
      deferCommitUntilPostRun: false,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
      onFailCommand: undefined,
      hideHookOutput: false,
      maxRepairAttempts: 1,
      allowRepair: true,
      trace: false,
      verbose: false,
      cliBlockExecutor: dependencies.cliBlockExecutor!,
      cliExpansionEnabled: true,
      task: resumedLoopTask!,
      sourceText: fileSystem.readText(loopTask.file),
      expandedSource: fileSystem.readText(loopTask.file),
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
      automationWorkerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      shouldVerify: false,
      runMode: "wait",
      verificationPrompt: "",
      artifactContext: {
        runId: "run-resume",
        rootDir: path.join(cwd, ".rundown", "runs", "run-resume"),
        cwd,
        keepArtifacts: true,
        commandName: "run",
      },
      cliExecutionOptionsWithVerificationTemplateFailureAbort: undefined,
      verificationFailureMessage: "unused",
      verificationFailureRunReason: "unused",
      extraTemplateVars: {},
    });

    expect(resumedResult).toEqual({ continueLoop: true, groupEnded: true });
    expect(fileSystem.readText(loopTask.file)).toBe([
      "- [x] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - [x] Do this",
      "  - [x] Do that",
      "",
    ].join("\n"));
  });

  it("inserts trace statistics after checking the task when enabled", async () => {
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
    const traceRunSession = {
      collectStatistics: vi.fn(() => ({
        fields: {
          total_time: 5_100,
          execution_time: 2_000,
          verify_time: 0,
          repair_time: 0,
          idle_time: 0,
          tokens_estimated: 42,
          phases_count: 1,
          verify_attempts: 0,
          repair_attempts: 0,
        },
      })),
    } as unknown as ReturnType<typeof createTraceRunSession>;

    const checkTaskSpy = vi.spyOn(checkboxOperationsModule, "checkTaskUsingFileSystem");
    const insertStatisticsSpy = vi.spyOn(checkboxOperationsModule, "insertTraceStatisticsUsingFileSystem");

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession,
      failRun: vi.fn(async () => 1),
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
      trace: false,
      verbose: false,
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
      extraTemplateVars: {},
      traceStatisticsConfig: {
        enabled: true,
        fields: ["total_time", "execution_time", "tokens_estimated"],
      },
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(checkTaskSpy).toHaveBeenCalledTimes(1);
    expect(insertStatisticsSpy).toHaveBeenCalledTimes(1);
    expect(insertStatisticsSpy.mock.calls[0]?.[1]).toEqual([
      "    - total time: 5s",
      "        - execution: 2s",
      "    - tokens estimated: 42",
    ]);
  });

  it("skips trace statistics insertion in detached mode", async () => {
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
    const traceRunSession = {
      collectStatistics: vi.fn(() => ({
        fields: {
          total_time: 5_100,
          execution_time: 2_000,
          verify_time: 0,
          repair_time: 0,
          idle_time: 0,
          tokens_estimated: 42,
          phases_count: 1,
          verify_attempts: 0,
          repair_attempts: 0,
        },
      })),
    } as unknown as ReturnType<typeof createTraceRunSession>;

    const insertStatisticsSpy = vi.spyOn(checkboxOperationsModule, "insertTraceStatisticsUsingFileSystem");

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession,
      failRun: vi.fn(async () => 1),
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
      trace: false,
      verbose: false,
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
      runMode: "detached",
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
      extraTemplateVars: {},
      traceStatisticsConfig: {
        enabled: true,
        fields: ["total_time", "execution_time", "tokens_estimated"],
      },
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(traceRunSession.collectStatistics).not.toHaveBeenCalled();
    expect(insertStatisticsSpy).not.toHaveBeenCalled();
  });

  it("skips trace statistics insertion before the final round", async () => {
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
    const traceRunSession = {
      collectStatistics: vi.fn(() => ({
        fields: {
          total_time: 5_100,
          execution_time: 2_000,
          verify_time: 0,
          repair_time: 0,
          idle_time: 0,
          tokens_estimated: 42,
          phases_count: 1,
          verify_attempts: 0,
          repair_attempts: 0,
        },
      })),
    } as unknown as ReturnType<typeof createTraceRunSession>;

    const insertStatisticsSpy = vi.spyOn(checkboxOperationsModule, "insertTraceStatisticsUsingFileSystem");

    const result = await completeTaskIteration({
      dependencies,
      emit: vi.fn(),
      state,
      traceRunSession,
      failRun: vi.fn(async () => 1),
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
      trace: false,
      verbose: false,
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
      runMode: "wait",
      currentRound: 1,
      totalRounds: 2,
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
      extraTemplateVars: {},
      traceStatisticsConfig: {
        enabled: true,
        fields: ["total_time", "execution_time", "tokens_estimated"],
      },
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(traceRunSession.collectStatistics).not.toHaveBeenCalled();
    expect(insertStatisticsSpy).not.toHaveBeenCalled();
  });

  it("skips remaining siblings when completion receives skipRemainingSiblings reason", async () => {
    const fileSystem = createInMemoryFileSystem({
      [task.file]: [
        "- [ ] end: no output to process",
        "- [ ] Do this and that",
      ].join("\n"),
    });
    const endTask = {
      ...task,
      text: "end: no output to process",
      line: 1,
      index: 0,
    };
    const { dependencies } = createDependencies({
      cwd,
      task: endTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });
    const state = {
      traceWriter: dependencies.traceWriter,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };

    const emit = vi.fn();
    const finishRun = vi.fn(async () => 0);
    const resetArtifacts = vi.fn();

    const result = await completeTaskIteration({
      dependencies,
      emit,
      state,
      traceRunSession: createCompletionSession(),
      failRun: vi.fn(async () => 1),
      finishRun,
      resetArtifacts,
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
      task: endTask,
      sourceText: fileSystem.readText(task.file),
      expandedSource: fileSystem.readText(task.file),
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
      skipRemainingSiblingsReason: "no output to process",
      extraTemplateVars: {},
    });

    expect(result).toEqual({ continueLoop: false, exitCode: 0, groupEnded: true });
    expect(fileSystem.readText(task.file)).toBe([
      "- [x] end: no output to process",
      "- [x] Do this and that",
      "  - skipped: no output to process",
    ].join("\n"));
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Skipped 1 sibling task because end condition was met.",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Skipped sibling: Do this and that (reason: no output to process)",
    });
    expect(finishRun).toHaveBeenCalledWith(0, "completed", true, undefined, undefined);
    expect(resetArtifacts).not.toHaveBeenCalled();
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
