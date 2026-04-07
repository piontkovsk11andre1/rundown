import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscussTask,
  type DiscussTaskDependencies,
  type DiscussTaskOptions,
} from "../../src/application/discuss-task.js";
import { DEFAULT_DISCUSS_TEMPLATE } from "../../src/domain/defaults.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import { FileLockError } from "../../src/domain/ports/file-lock.js";
import type { Task } from "../../src/domain/parser.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  CommandExecutor,
  FileLock,
  FileSystem,
  TemplateLoader,
  TraceWriterPort,
} from "../../src/domain/ports/index.js";

describe("discuss-task", () => {
  it("selects the next task from resolved sources using the requested sort mode", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const notesFile = path.join(cwd, "notes.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
      [notesFile]: "- [ ] Another task\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.sourceResolver.resolveSources).mockResolvedValue([taskFile, notesFile]);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "**/*.md",
      sortMode: "old-first",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.sourceResolver.resolveSources)).toHaveBeenCalledWith("**/*.md");
    expect(vi.mocked(dependencies.taskSelector.selectNextTask)).toHaveBeenCalledWith(
      [taskFile, notesFile],
      "old-first",
    );
  });

  it("renders discuss prompt with standard template vars and --var overrides", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.index = 5;
    task.line = 42;
    task.children = [createTask(taskFile, "Nested child")];
    task.children[0]!.index = 6;
    task.children[0]!.line = 43;
    task.children[0]!.depth = 1;
    task.subItems = [{ text: "Clarify assumptions", line: 44, depth: 1 }];
    const source = "# Plan\n\n- [ ] Refine rollout scope\n  - [ ] Nested child\n  - Clarify assumptions\n";
    const contextBefore = "# Plan\n";

    const fileSystem = createInMemoryFileSystem({
      [taskFile]: source,
    });

    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source,
      contextBefore,
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "{{task}}|{{file}}|{{taskLine}}|{{taskIndex}}|{{source}}|{{context}}|{{children}}|{{subItems}}|{{branch}}";
      }
      return null;
    });
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({
      branch: "main",
      children: "[{\"text\":\"Injected child\"}]",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
      varsFileOption: ".rundown/vars.json",
      cliTemplateVarArgs: ["branch=release"],
    }));

    expect(code).toBe(0);
    const promptEvent = events.find((event) => event.kind === "text");
    expect(promptEvent).toBeDefined();
    expect(promptEvent).toEqual(expect.objectContaining({ kind: "text" }));
    if (promptEvent?.kind === "text") {
      expect(promptEvent.text).toContain("Refine rollout scope");
      expect(promptEvent.text).toContain(taskFile);
      expect(promptEvent.text).toContain("|42|5|");
      expect(promptEvent.text).toContain("# Plan");
      expect(promptEvent.text).toContain("\"text\":\"Nested child\"");
      expect(promptEvent.text).toContain("\"text\":\"Clarify assumptions\"");
      expect(promptEvent.text).not.toContain("Injected child");
      expect(promptEvent.text).toContain("|release");
    }
  });

  it("includes memory path and summary in discuss prompt without memory body text", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const source = "- [ ] Refine rollout scope\n";
    const memoryBodyText = "MEMORY-BODY-SHOULD-NOT-BE-INLINED";
    const memoryFilePath = path.join(cwd, ".rundown", "tasks.memory.md");

    const fileSystem = createInMemoryFileSystem({
      [taskFile]: source,
    });

    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source,
      contextBefore: "",
      fileSystem,
    });
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: true,
        filePath: memoryFilePath,
        summary: "Discussed constraints and rollout notes",
      })),
    };

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "Memory path: {{memoryFilePath}}\nMemory summary: {{memorySummary}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("Memory path: " + memoryFilePath);
    expect(prompt).toContain("Memory summary: Discussed constraints and rollout notes");
    expect(prompt).not.toContain(memoryBodyText);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(taskFile);
  });

  it("keeps dry-run exit code and behavior when memory metadata is unavailable", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: false,
        filePath: path.join(cwd, ".rundown", "tasks.memory.md"),
        summary: undefined,
      })),
    };

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run — would discuss with: opencode run"))).toBe(true);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(taskFile);
  });

  it("print-prompt renders and prints discuss prompt without launching worker", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "Discuss prompt for: {{task}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: "text", text: "Discuss prompt for: Refine rollout scope" });
  });

  it("uses --run latest to render discuss-finished prompt from saved run artifacts", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");
    const verifyDir = path.join(runDir, "02-verify");
    const repairDir = path.join(runDir, "03-repair");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
      [path.join(verifyDir, "metadata.json"), JSON.stringify({
        sequence: 2,
        phase: "verify",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
        verificationResult: "OK",
      })],
      [path.join(repairDir, "metadata.json"), JSON.stringify({
        sequence: 3,
        phase: "repair",
        promptFile: "prompt.md",
        stdoutFile: null,
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir || filePath === verifyDir || filePath === repairDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [
          { name: "01-execute", isFile: false, isDirectory: true },
          { name: "02-verify", isFile: false, isDirectory: true },
          { name: "03-repair", isFile: false, isDirectory: true },
        ];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir || filePath === verifyDir || filePath === repairDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.latest).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {
        commitSha: "abc123",
      },
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return [
          "run={{runId}}",
          "status={{runStatus}}",
          "exec={{executionPhaseDir}}",
          "verify={{verifyPhaseDirs}}",
          "repair={{repairPhaseDirs}}",
          "phase={{phaseSummary}}",
          "missing={{missingLogsSummary}}",
        ].join("\n");
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "latest",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.sourceResolver.resolveSources)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.taskSelector.selectNextTask)).not.toHaveBeenCalled();
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("run=run-finished");
    expect(prompt).toContain("status=completed");
    expect(prompt).toContain("exec=" + executeDir);
    expect(prompt).toContain("verify=- " + verifyDir);
    expect(prompt).toContain("repair=- " + repairDir);
    expect(prompt).toContain("[02] verify");
    expect(prompt).toContain("[01] execute (01-execute): missing stdout.log and stderr.log");
    expect(prompt).toContain("[02] verify (02-verify): missing stdout.log and stderr.log");
    expect(prompt).toContain("[03] repair (03-repair): missing stdout.log and stderr.log");
  });

  it("assembles discuss-finished template vars from run metadata with missing optional values", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");

    const fileSystem: FileSystem = {
      exists: (filePath) => filePath === runDir || filePath === taskFile,
      readText: (filePath) => {
        if (filePath === taskFile) {
          return [
            "# Heading",
            "",
            "- [x] Refine rollout scope",
          ].join("\n") + "\n";
        }
        throw new Error("ENOENT: " + filePath);
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath === runDir) {
          return [];
        }
        return [];
      },
      stat: (filePath) => {
        if (filePath === runDir) {
          return { isFile: false, isDirectory: true };
        }
        if (filePath === taskFile) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {},
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return [
          "run={{runId}}",
          "status={{runStatus}}",
          "runDir={{runDir}}",
          "taskText={{taskText}}",
          "taskFile={{taskFile}}",
          "taskLine={{taskLine}}",
          "taskLineFromRun={{taskLineFromRun}}",
          "selectedTaskLine={{selectedTaskLine}}",
          "commit={{commitSha}}",
          "exec={{executionPhaseDir}}",
          "verify={{verifyPhaseDirs}}",
          "repair={{repairPhaseDirs}}",
          "phase={{phaseSummary}}",
          "missing={{missingLogsSummary}}",
        ].join("\n");
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("run=run-finished");
    expect(prompt).toContain("status=completed");
    expect(prompt).toContain("runDir=" + runDir);
    expect(prompt).toContain("taskText=Refine rollout scope");
    expect(prompt).toContain("taskFile=" + taskFile);
    expect(prompt).toContain("taskLine=1");
    expect(prompt).toContain("taskLineFromRun=1");
    expect(prompt).toContain("selectedTaskLine=3");
    expect(prompt).toContain("commit=(none)");
    expect(prompt).toContain("exec=(missing)");
    expect(prompt).toContain("verify=- (none)");
    expect(prompt).toContain("repair=- (none)");
    expect(prompt).toContain("phase=No execute/verify/repair phases were discovered in this run directory.");
    expect(prompt).toContain("missing=No phase artifacts were discovered, so no stdout/stderr logs are available.");
  });

  it("assembles discuss-finished template vars for a complete run with execute/verify/repair phases", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-complete");
    const executeDir = path.join(runDir, "01-execute");
    const verifyDir = path.join(runDir, "02-verify");
    const repairDir = path.join(runDir, "03-repair");
    const executeStdout = path.join(executeDir, "stdout.log");
    const executeStderr = path.join(executeDir, "stderr.log");
    const executePrompt = path.join(executeDir, "prompt.md");
    const verifyStdout = path.join(verifyDir, "stdout.log");
    const verifyStderr = path.join(verifyDir, "stderr.log");
    const verifyPrompt = path.join(verifyDir, "prompt.md");
    const repairStdout = path.join(repairDir, "stdout.log");
    const repairStderr = path.join(repairDir, "stderr.log");
    const repairPrompt = path.join(repairDir, "prompt.md");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: "stderr.log",
        exitCode: 0,
      })],
      [path.join(verifyDir, "metadata.json"), JSON.stringify({
        sequence: 2,
        phase: "verify",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: "stderr.log",
        exitCode: 0,
        verificationResult: "OK",
      })],
      [path.join(repairDir, "metadata.json"), JSON.stringify({
        sequence: 3,
        phase: "repair",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: "stderr.log",
        exitCode: 0,
      })],
      [executeStdout, "execute out"],
      [executeStderr, "execute err"],
      [executePrompt, "execute prompt"],
      [verifyStdout, "verify out"],
      [verifyStderr, "verify err"],
      [verifyPrompt, "verify prompt"],
      [repairStdout, "repair out"],
      [repairStderr, "repair err"],
      [repairPrompt, "repair prompt"],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir || filePath === verifyDir || filePath === repairDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [
          { name: "01-execute", isFile: false, isDirectory: true },
          { name: "02-verify", isFile: false, isDirectory: true },
          { name: "03-repair", isFile: false, isDirectory: true },
        ];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir || filePath === verifyDir || filePath === repairDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    task.line = 10;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-complete",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-complete",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {
        commitSha: "abc123",
      },
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return [
          "run={{runId}}",
          "status={{runStatus}}",
          "dir={{runDir}}",
          "taskText={{taskText}}",
          "taskFile={{taskFile}}",
          "taskLine={{taskLine}}",
          "taskLineFromRun={{taskLineFromRun}}",
          "selectedTaskLine={{selectedTaskLine}}",
          "commit={{commitSha}}",
          "exec={{executionPhaseDir}}",
          "verify={{verifyPhaseDirs}}",
          "repair={{repairPhaseDirs}}",
          "phase={{phaseSummary}}",
          "missing={{missingLogsSummary}}",
        ].join("\n");
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-complete",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("run=run-complete");
    expect(prompt).toContain("status=completed");
    expect(prompt).toContain("dir=" + runDir);
    expect(prompt).toContain("taskText=Refine rollout scope");
    expect(prompt).toContain("taskFile=" + taskFile);
    expect(prompt).toContain("taskLine=1");
    expect(prompt).toContain("taskLineFromRun=1");
    expect(prompt).toContain("selectedTaskLine=1");
    expect(prompt).toContain("commit=abc123");
    expect(prompt).toContain("exec=" + executeDir);
    expect(prompt).toContain("verify=- " + verifyDir);
    expect(prompt).toContain("repair=- " + repairDir);
    expect(prompt).toContain("[01] execute (01-execute): exit=0, verification=(n/a), prompt=present, stdout=present, stderr=present");
    expect(prompt).toContain("[02] verify (02-verify): exit=0, verification=OK, prompt=present, stdout=present, stderr=present");
    expect(prompt).toContain("[03] repair (03-repair): exit=0, verification=(n/a), prompt=present, stdout=present, stderr=present");
    expect(prompt).toContain("missing=All discovered phases include stdout/stderr log files.");
  });

  it("sets commitSha template var to commit id when available and (none) when missing", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-commit");

    const fileSystem: FileSystem = {
      exists: (filePath) => filePath === runDir || filePath === taskFile,
      readText: (filePath) => {
        if (filePath === taskFile) {
          return "- [x] Refine rollout scope\n";
        }
        throw new Error("ENOENT: " + filePath);
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: () => [],
      stat: (filePath) => {
        if (filePath === runDir) {
          return { isFile: false, isDirectory: true };
        }
        if (filePath === taskFile) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return "commit={{commitSha}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-commit",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-commit",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {
        commitSha: "deadbeef",
      },
    });

    const withCommit = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-commit",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(withCommit).toBe(0);
    expect(events.find((event) => event.kind === "text")?.text).toBe("commit=deadbeef");

    events.length = 0;
    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-commit",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-commit",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {},
    });

    const withoutCommit = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-commit",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(withoutCommit).toBe(0);
    expect(events.find((event) => event.kind === "text")?.text).toBe("commit=(none)");
  });

  it("reports missing stdout/stderr logs in discuss-finished template vars", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-missing-logs");
    const executeDir = path.join(runDir, "01-execute");
    const verifyDir = path.join(runDir, "02-verify");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
      [path.join(verifyDir, "metadata.json"), JSON.stringify({
        sequence: 2,
        phase: "verify",
        promptFile: "prompt.md",
        stdoutFile: null,
        stderrFile: null,
        exitCode: 1,
        verificationResult: "NOT_OK: test failures",
      })],
      [path.join(executeDir, "prompt.md"), "execute prompt"],
      [path.join(verifyDir, "prompt.md"), "verify prompt"],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir || filePath === verifyDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [
          { name: "01-execute", isFile: false, isDirectory: true },
          { name: "02-verify", isFile: false, isDirectory: true },
        ];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir || filePath === verifyDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-missing-logs",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-missing-logs",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "failed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {},
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return "missing={{missingLogsSummary}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-missing-logs",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("[01] execute (01-execute): missing stdout.log and stderr.log");
    expect(prompt).toContain("[02] verify (02-verify): missing stdout.log and stderr.log");
    expect(prompt).toContain("Output may not have been captured");
  });

  it("includes all repair attempts in phaseSummary for discuss-finished template vars", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-multi-repair");
    const executeDir = path.join(runDir, "01-execute");
    const verifyDir = path.join(runDir, "02-verify");
    const repairAttemptOneDir = path.join(runDir, "03-repair");
    const repairAttemptTwoDir = path.join(runDir, "05-repair");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: null,
        stdoutFile: null,
        stderrFile: null,
        exitCode: 0,
      })],
      [path.join(verifyDir, "metadata.json"), JSON.stringify({
        sequence: 2,
        phase: "verify",
        promptFile: null,
        stdoutFile: null,
        stderrFile: null,
        exitCode: 1,
        verificationResult: "NOT_OK: lint",
      })],
      [path.join(repairAttemptOneDir, "metadata.json"), JSON.stringify({
        sequence: 3,
        phase: "repair",
        promptFile: null,
        stdoutFile: null,
        stderrFile: null,
        exitCode: 0,
      })],
      [path.join(repairAttemptTwoDir, "metadata.json"), JSON.stringify({
        sequence: 5,
        phase: "repair",
        promptFile: null,
        stdoutFile: null,
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (
          filePath === runDir
          || filePath === executeDir
          || filePath === verifyDir
          || filePath === repairAttemptOneDir
          || filePath === repairAttemptTwoDir
        ) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [
          { name: "01-execute", isFile: false, isDirectory: true },
          { name: "02-verify", isFile: false, isDirectory: true },
          { name: "03-repair", isFile: false, isDirectory: true },
          { name: "05-repair", isFile: false, isDirectory: true },
        ];
      },
      stat: (filePath) => {
        if (
          filePath === runDir
          || filePath === executeDir
          || filePath === verifyDir
          || filePath === repairAttemptOneDir
          || filePath === repairAttemptTwoDir
        ) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-multi-repair",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-multi-repair",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {},
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return "phase={{phaseSummary}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-multi-repair",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("[03] repair (03-repair): exit=0");
    expect(prompt).toContain("[05] repair (05-repair): exit=0");
    expect(prompt).toContain("[02] verify (02-verify): exit=1, verification=NOT_OK: lint");
  });

  it("uses run.json task text in discuss-finished template vars when task source file is deleted", async () => {
    const cwd = "/workspace";
    const runDir = path.join(cwd, ".rundown", "runs", "run-fallback-task-text");
    const deletedTaskFile = path.join(cwd, "deleted-task-file.md");
    const selectedTaskFile = path.join(cwd, "tasks.md");

    const fileSystem: FileSystem = {
      exists: (filePath) => filePath === runDir,
      readText: () => {
        throw new Error("ENOENT");
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: () => [],
      stat: (filePath) => {
        if (filePath === runDir) {
          return { isFile: false, isDirectory: true };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(selectedTaskFile, "Ignored selected task text");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Ignored selected task text\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-fallback-task-text",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-fallback-task-text",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Text from run metadata",
        file: deletedTaskFile,
        line: 9,
        index: 3,
        source: "# Old file\n\n- [x] Text from run metadata\n",
      },
      extra: {},
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return [
          "task={{task}}",
          "taskText={{taskText}}",
          "taskFile={{taskFile}}",
          "selectedFile={{file}}",
        ].join("\n");
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-fallback-task-text",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("task=Text from run metadata");
    expect(prompt).toContain("taskText=Text from run metadata");
    expect(prompt).toContain("taskFile=" + deletedTaskFile);
    expect(prompt).toContain("selectedFile=" + deletedTaskFile);
  });

  it("falls back to run.json task metadata when the source task file was moved or deleted", async () => {
    const cwd = "/workspace";
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const missingTaskFile = path.join(cwd, "tasks-moved.md");

    const fileSystem: FileSystem = {
      exists: (filePath) => filePath === runDir,
      readText: (filePath) => {
        throw new Error("ENOENT: " + filePath);
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath === runDir) {
          return [];
        }
        return [];
      },
      stat: (filePath) => {
        if (filePath === runDir) {
          return { isFile: false, isDirectory: true };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(path.join(cwd, "tasks.md"), "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: missingTaskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
      extra: {},
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return [
          "task={{task}}",
          "taskFile={{taskFile}}",
          "selectedFile={{file}}",
        ].join("\n");
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("using saved run metadata from run.json"))).toBe(true);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("task=Refine rollout scope");
    expect(prompt).toContain("taskFile=" + missingTaskFile);
    expect(prompt).toContain("selectedFile=" + missingTaskFile);
  });

  it("finalizes discuss-finished sessions with discuss-finished-completed status on success", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [{ name: "01-execute", isFile: false, isDirectory: true }];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.artifactStore.createContext)).toHaveBeenCalledWith(expect.objectContaining({
      commandName: "discuss-finished",
    }));
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "discuss-finished-completed",
    }));
  });

  it("emits finished-discussion trace events for --run discussions", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [{ name: "01-execute", isFile: false, isDirectory: true }];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    task.line = 42;
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 42,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      trace: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const eventTypes = vi.mocked(dependencies.traceWriter.write).mock.calls
      .map((call) => call[0]?.event_type);
    expect(eventTypes).toEqual([
      "discussion.started",
      "discussion.finished.started",
      "discussion.completed",
      "discussion.finished.completed",
    ]);
    expect(vi.mocked(dependencies.traceWriter.write)).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event_type: "discussion.finished.started",
      payload: expect.objectContaining({
        target_run_id: "run-finished",
        target_run_status: "completed",
      }),
    }));
    expect(vi.mocked(dependencies.traceWriter.write)).toHaveBeenNthCalledWith(4, expect.objectContaining({
      event_type: "discussion.finished.completed",
      payload: expect.objectContaining({
        target_run_id: "run-finished",
        target_run_status: "completed",
        exit_code: 0,
      }),
    }));
  });

  it("acquires source lock for --run discussions before worker invocation and releases it afterward", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [{ name: "01-execute", isFile: false, isDirectory: true }];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(taskFile, { command: "discuss" });
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);

    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    const workerOrder = vi.mocked(dependencies.workerExecutor.runWorker).mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];

    expect(lockAcquireOrder).toBeLessThan(workerOrder);
    expect(workerOrder).toBeLessThan(releaseOrder);
  });

  it("finalizes discuss-finished sessions with discuss-finished-cancelled status on failure", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [{ name: "01-execute", isFile: false, isDirectory: true }];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 9,
      stdout: "",
      stderr: "",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(9);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "discuss-finished-cancelled",
    }));
  });

  it("restores checkbox state and cancels discuss-finished when worker toggles checkboxes", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: "stdout.log",
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: (filePath, content) => {
        files.set(filePath, content);
      },
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [{ name: "01-execute", isFile: false, isDirectory: true }];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockImplementation(async () => {
      files.set(taskFile, "- [ ] Refine rollout scope\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Discussion changed checkbox state"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "discuss-finished-cancelled",
    }));
    expect(files.get(taskFile)).toBe("- [x] Refine rollout scope\n");
  });

  it("returns 3 when --run latest cannot resolve a saved run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.latest).mockReturnValue(null);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "latest",
    }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("No saved runtime artifact run found for: latest"))).toBe(true);
    expect(vi.mocked(dependencies.sourceResolver.resolveSources)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("returns 3 when explicit --run id cannot resolve a saved run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue(null);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-does-not-exist",
    }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("No saved runtime artifact run found for: run-does-not-exist"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.find)).toHaveBeenCalledWith(
      "run-does-not-exist",
      path.join(cwd, ".rundown"),
    );
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("returns 3 when --run prefix is ambiguous and does not resolve to a unique run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue(null);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-",
    }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("No saved runtime artifact run found for: run-"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.find)).toHaveBeenCalledWith(
      "run-",
      path.join(cwd, ".rundown"),
    );
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("returns 3 when selected run is not in supported terminal status set", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "reverify-completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
    }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Selected run is not in a terminal state"))).toBe(true);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("returns 3 when selected run is missing task metadata", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
    }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Selected run has no task metadata to discuss"))).toBe(true);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("returns 3 when selected run artifact directory was purged", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
    }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Selected run has no saved artifact directory"))).toBe(true);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("No saved artifacts are available on disk"))).toBe(true);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("purged"))).toBe(true);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("expands cli blocks in rendered discuss prompt before printing", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    dependencies.cliBlockExecutor = cliBlockExecutor;

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).toHaveBeenCalledWith(
      "echo hello",
      cwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    expect(events).toContainEqual({
      kind: "text",
      text: "<command>echo hello</command>\n<output>\nhello\n\n</output>",
    });
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("passes exec timeout to cli block expansion in discuss prompt", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
      cliBlockTimeoutMs: 1234,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).toHaveBeenCalledWith(
      "echo hello",
      cwd,
      expect.objectContaining({
        timeoutMs: 1234,
        onCommandExecuted: expect.any(Function),
      }),
    );
  });

  it("skips cli block expansion when ignoreCliBlock is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
      ignoreCliBlock: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "text",
      text: "```cli\necho hello\n```",
    });
  });

  it("emits an error and aborts when discuss template cli block fails", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 9,
        stdout: "",
        stderr: "template failed",
      })),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: "`cli` fenced command failed in discuss template (exit 9): echo hello. Aborting run.",
    }));
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("emits a discuss-finished template error when --run prompt cli block fails", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const runDir = path.join(cwd, ".rundown", "runs", "run-finished");
    const executeDir = path.join(runDir, "01-execute");

    const files = new Map<string, string>([
      [taskFile, "- [x] Refine rollout scope\n"],
      [path.join(executeDir, "metadata.json"), JSON.stringify({
        sequence: 1,
        phase: "execute",
        promptFile: "prompt.md",
        stdoutFile: null,
        stderrFile: null,
        exitCode: 0,
      })],
    ]);

    const fileSystem: FileSystem = {
      exists: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return true;
        }
        return files.has(filePath);
      },
      readText: (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error("ENOENT: " + filePath);
        }
        return content;
      },
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: (dirPath) => {
        if (dirPath !== runDir) {
          return [];
        }
        return [{ name: "01-execute", isFile: false, isDirectory: true }];
      },
      stat: (filePath) => {
        if (filePath === runDir || filePath === executeDir) {
          return { isFile: false, isDirectory: true };
        }
        if (files.has(filePath)) {
          return { isFile: true, isDirectory: false };
        }
        return null;
      },
      unlink: vi.fn(),
      rm: vi.fn(),
    };

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 5,
        stdout: "",
        stderr: "template failed",
      })),
    };

    const task = createTask(taskFile, "Refine rollout scope");
    task.checked = true;
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [x] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
      cliBlockExecutor,
    });

    vi.mocked(dependencies.artifactStore.find).mockReturnValue({
      runId: "run-finished",
      rootDir: runDir,
      relativePath: ".rundown/runs/run-finished",
      commandName: "run",
      keepArtifacts: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
      source: "tasks.md",
      task: {
        text: "Refine rollout scope",
        file: taskFile,
        line: 1,
        index: 0,
        source: "- [x] Refine rollout scope\n",
      },
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss-finished.md"))) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      runId: "run-finished",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: "`cli` fenced command failed in discuss-finished template (exit 5): echo hello. Aborting run.",
    }));
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("includes user-supplied --var values in rendered discuss prompt", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "Release channel: {{releaseChannel}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
      cliTemplateVarArgs: ["releaseChannel=beta"],
    }));

    expect(code).toBe(0);
    expect(events).toContainEqual({ kind: "text", text: "Release channel: beta" });
  });

  it("loads --vars-file values into rendered discuss prompt", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "Team: {{team}}";
      }
      return null;
    });
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({
      team: "platform",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      printPrompt: true,
      varsFileOption: ".rundown/vars.json",
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.templateVarsLoader.load)).toHaveBeenCalledWith(
      ".rundown/vars.json",
      cwd,
      path.join(cwd, ".rundown"),
    );
    expect(events).toContainEqual({ kind: "text", text: "Team: platform" });
  });

  it("reports dry-run details and does not execute worker", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run — would discuss with: opencode run"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt length:"))).toBe(true);
  });

  it("dry-run skips cli block expansion and reports skipped block count", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "info",
      message: "Dry run — skipped `cli` fenced block execution; would execute 1 block.",
    });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run — would discuss with: opencode run"))).toBe(true);
  });

  it("dry-run prints resolved task info without launching worker", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.line = 17;
    task.index = 3;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message
      === `Next task: ${taskFile}:17 [#3] Refine rollout scope`)).toBe(true);
  });

  it("runs worker in tui discuss phase with rendered prompt", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.index = 5;
    task.line = 42;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "discuss.md"))) {
        return "Discuss: {{task}}";
      }
      return null;
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      mode: "wait",
      transport: "arg",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledWith(expect.objectContaining({
      workerPattern: expect.objectContaining({
        command: ["opencode", "run"],
      }),
      prompt: "Discuss: Refine rollout scope",
      mode: "tui",
      captureOutput: false,
      artifactPhase: "discuss",
      cwd,
    }));
    expect(events).toContainEqual({
      kind: "info",
      message: "Running discussion worker: opencode run [mode=tui]",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "Discussion worker completed (exit 0).",
    });
  });

  it("emits group-start/group-end events for a successful discussion turn", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.index = 5;
    task.line = 42;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "group-start",
      label: "Discuss turn: " + taskFile + ":42 [#5] Refine rollout scope",
      counter: {
        current: 1,
        total: 1,
      },
    });
    expect(events).toContainEqual({ kind: "group-end", status: "success" });
  });

  it("acquires source lock before worker invocation and releases locks after worker exit", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(taskFile, { command: "discuss" });
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);

    const acquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    const workerOrder = vi.mocked(dependencies.workerExecutor.runWorker).mock.invocationCallOrder[0];
    const releaseOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];

    expect(acquireOrder).toBeLessThan(workerOrder);
    expect(workerOrder).toBeLessThan(releaseOrder);
  });

  it("falls back to DEFAULT_DISCUSS_TEMPLATE when discuss template is missing", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.line = 42;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "# Plan\n",
      fileSystem,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue(null);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const workerCall = vi.mocked(dependencies.workerExecutor.runWorker).mock.calls[0]?.[0];
    expect(workerCall).toBeDefined();
    expect(workerCall?.prompt).toContain("Discuss and refine the selected task before execution.");
    expect(workerCall?.prompt).toContain("Refine rollout scope");
    expect(workerCall?.prompt).toContain("`" + taskFile + "` (line 42)");
    expect(DEFAULT_DISCUSS_TEMPLATE).toContain("Discuss and refine the selected task before execution.");
  });

  it("captures discuss output into artifacts when --keep-artifacts is set", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "captured stdout\n",
      stderr: "captured stderr\n",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      keepArtifacts: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledWith(expect.objectContaining({
      captureOutput: true,
      mode: "tui",
      artifactPhase: "discuss",
    }));
    expect(events.some((event) => event.kind === "text")).toBe(false);
    expect(events.some((event) => event.kind === "stderr")).toBe(false);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at"))).toBe(true);
  });

  it("emits discussion.started and discussion.completed trace events with duration and exit code", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.index = 5;
    task.line = 42;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      trace: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.createTraceWriter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.createTraceWriter)).toHaveBeenCalledWith(true, expect.objectContaining({
      commandName: "discuss",
    }));
    const eventTypes = vi.mocked(dependencies.traceWriter.write).mock.calls
      .map((call) => call[0]?.event_type);
    expect(eventTypes).toEqual(["discussion.started", "discussion.completed"]);
    expect(vi.mocked(dependencies.traceWriter.write)).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event_type: "discussion.started",
      payload: expect.objectContaining({
        task_text: "Refine rollout scope",
        task_file: taskFile,
        task_line: 42,
      }),
    }));
    expect(vi.mocked(dependencies.traceWriter.write)).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event_type: "discussion.completed",
      payload: expect.objectContaining({
        task_text: "Refine rollout scope",
        task_file: taskFile,
        task_line: 42,
        exit_code: 0,
      }),
    }));
    const completedPayload = vi.mocked(dependencies.traceWriter.write).mock.calls[1]?.[0]?.payload as
      | { duration_ms: number }
      | undefined;
    expect(completedPayload).toBeDefined();
    expect(typeof completedPayload?.duration_ms).toBe("number");
    expect((completedPayload?.duration_ms ?? -1) >= 0).toBe(true);
    expect(vi.mocked(dependencies.traceWriter.flush)).toHaveBeenCalledTimes(1);
  });

  it("records non-zero worker exit code in discussion.completed trace payload", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    task.index = 5;
    task.line = 42;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 7,
      stdout: "",
      stderr: "",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      trace: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(7);
    expect(vi.mocked(dependencies.traceWriter.write)).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event_type: "discussion.completed",
      payload: expect.objectContaining({
        exit_code: 7,
      }),
    }));
  });

  it("emits group-end failure event when discussion worker exits non-zero", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 7,
      stdout: "",
      stderr: "",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(7);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "group-end",
      status: "failure",
      message: "Discussion exited with code 7.",
    }));
  });

  it("returns 1 when worker exits without an exit code", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: null,
      stdout: "",
      stderr: "",
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("worker exited without a code"))).toBe(true);
  });

  it("returns 1 when discussion mutates checkbox state", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockImplementation(async () => {
      fileSystem.writeText(taskFile, "- [x] Refine rollout scope\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Discussion changed checkbox state"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "discuss-cancelled",
    }));
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Refine rollout scope\n");
  });

  it("returns 1 when checkbox state flips while task text changes", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockImplementation(async () => {
      fileSystem.writeText(taskFile, "- [x] Refine rollout scope for Q2\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Discussion changed checkbox state"))).toBe(true);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Refine rollout scope\n");
  });

  it("returns 1 when checked and unchecked items swap state with unchanged totals", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "First item");
    const initialSource = [
      "- [ ] First item",
      "- [x] Second item",
    ].join("\n") + "\n";
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: initialSource,
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: initialSource,
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockImplementation(async () => {
      fileSystem.writeText(taskFile, [
        "- [x] First item renamed",
        "- [ ] Second item renamed",
      ].join("\n") + "\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Discussion changed checkbox state"))).toBe(true);
    expect(fileSystem.readText(taskFile)).toBe(initialSource);
  });

  it("allows rewriting task text when checkbox state is unchanged", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockImplementation(async () => {
      fileSystem.writeText(taskFile, "- [ ] Refine rollout scope for Q2\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "discuss-completed",
    }));
  });

  it("does not mutate any checkbox in the source file", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [x] Completed setup",
        "- [ ] Refine rollout scope",
      ].join("\n") + "\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: [
        "- [x] Completed setup",
        "- [ ] Refine rollout scope",
      ].join("\n") + "\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockImplementation(async () => {
      fileSystem.writeText(taskFile, [
        "- [x] Completed setup",
        "- [ ] Refine rollout scope for Q2",
      ].join("\n") + "\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] Completed setup",
      "- [ ] Refine rollout scope for Q2",
    ].join("\n") + "\n");
  });

  it("acquires a lock for each resolved source before task selection and releases locks on exit", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const notesFile = path.join(cwd, "notes.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
      [notesFile]: "- [ ] Secondary\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.sourceResolver.resolveSources).mockResolvedValue([taskFile, notesFile]);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "*.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenNthCalledWith(1, taskFile, { command: "discuss" });
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenNthCalledWith(2, notesFile, { command: "discuss" });
    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    const taskSelectOrder = vi.mocked(dependencies.taskSelector.selectNextTask).mock.invocationCallOrder[0];
    expect(lockAcquireOrder).toBeLessThan(taskSelectOrder);
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("force-unlocks stale source locks before acquiring discuss locks", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.fileLock.isLocked).mockReturnValue(false);

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
      forceUnlock: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).toHaveBeenCalledWith(taskFile);
    const forceReleaseOrder = vi.mocked(dependencies.fileLock.forceRelease).mock.invocationCallOrder[0];
    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    expect(forceReleaseOrder).toBeLessThan(lockAcquireOrder);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Force-unlocked stale source lock"))).toBe(true);
  });

  it("returns 1 with a clear message when a source file lock is already held", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Refine rollout scope");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Refine rollout scope\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task,
      source: "- [ ] Refine rollout scope\n",
      contextBefore: "",
      fileSystem,
    });

    vi.mocked(dependencies.fileLock.acquire).mockImplementation(() => {
      throw new FileLockError(taskFile, {
        pid: 1234,
        command: "run",
        startTime: "2026-01-01T00:00:00.000Z",
      });
    });

    const discussTask = createDiscussTask(dependencies);
    const code = await discussTask(createOptions({
      source: "tasks.md",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Source file is locked by another rundown process"))).toBe(true);
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("--force-unlock"))).toBe(true);
  });
});

function createDependencies(options: {
  cwd: string;
  task: Task;
  source: string;
  contextBefore: string;
  fileSystem: FileSystem;
  cliBlockExecutor?: CommandExecutor;
}): { dependencies: DiscussTaskDependencies; events: ApplicationOutputEvent[] } {
  const events: ApplicationOutputEvent[] = [];
  const templateLoader: TemplateLoader = { load: vi.fn(() => null) };
  const cliBlockExecutor: CommandExecutor = options.cliBlockExecutor ?? {
    execute: vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
  };
  const traceWriter: TraceWriterPort = {
    write: vi.fn(),
    flush: vi.fn(),
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-test",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-test"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "discuss",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-test")),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const dependencies: DiscussTaskDependencies = {
    sourceResolver: {
      resolveSources: vi.fn(async () => [options.task.file]),
    },
    taskSelector: {
      selectNextTask: vi.fn(() => ({
        task: options.task,
        source: options.source,
        contextBefore: options.contextBefore,
      })),
      selectTaskByLocation: vi.fn(() => null),
    },
    workerExecutor: {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
    workingDirectory: {
      cwd: vi.fn(() => options.cwd),
    },
    fileSystem: options.fileSystem,
    fileLock: createNoopFileLock(),
    templateLoader,
    artifactStore,
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    templateVarsLoader: {
      load: vi.fn(() => ({})),
    },
    workerConfigPort: { load: vi.fn(() => undefined) },
    traceWriter,
    cliBlockExecutor,
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
    },
    createTraceWriter: vi.fn(() => traceWriter),
    output: {
      emit: (event) => {
        events.push(event);
      },
    },
  };

  return {
    dependencies,
    events,
  };
}

function createTask(file: string, text: string): Task {
  return {
    text,
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: text.length,
    file,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

function createInMemoryFileSystem(initialFiles: Record<string, string>): FileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    exists: (filePath) => files.has(filePath),
    readText: (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error("ENOENT: " + filePath);
      }
      return content;
    },
    writeText: (filePath, content) => {
      files.set(filePath, content);
    },
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<DiscussTaskOptions> & { workerCommand?: string[]; transport?: string },
): DiscussTaskOptions {
  const { workerCommand, transport: _transport, ...optionOverrides } = overrides;
  const workerPattern = optionOverrides.workerPattern
    ?? inferWorkerPatternFromCommand(workerCommand ?? []);

  return {
    source: "tasks.md",
    mode: "tui",
    workerPattern,
    sortMode: "name-sort",
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: undefined,
    cliTemplateVarArgs: [],
    showAgentOutput: false,
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    ...optionOverrides,
  };
}

function createNoopFileLock(): FileLock {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(),
    isLocked: vi.fn(() => false),
    forceRelease: vi.fn(),
  };
}
