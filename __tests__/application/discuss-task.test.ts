import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscussTask,
  type DiscussTaskDependencies,
  type DiscussTaskOptions,
} from "../../src/application/discuss-task.js";
import { DEFAULT_DISCUSS_TEMPLATE } from "../../src/domain/defaults.js";
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
    const { dependencies } = createDependencies({
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
      command: ["opencode", "run"],
      prompt: "Discuss: Refine rollout scope",
      mode: "tui",
      transport: "arg",
      captureOutput: false,
      artifactPhase: "discuss",
      cwd,
    }));
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
    isRundownTask: false,
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

function createOptions(overrides: Partial<DiscussTaskOptions>): DiscussTaskOptions {
  return {
    source: "tasks.md",
    mode: "tui",
    transport: "file",
    sortMode: "name-sort",
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: undefined,
    cliTemplateVarArgs: [],
    workerCommand: [],
    showAgentOutput: false,
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    ...overrides,
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
