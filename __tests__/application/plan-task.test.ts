import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPlanTask, type PlanTaskDependencies, type PlanTaskOptions } from "../../src/application/plan-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  CommandExecutor,
  FileSystem,
} from "../../src/domain/ports/index.js";
import { FileLockError, type FileLock } from "../../src/domain/ports/file-lock.js";

describe("plan-task", () => {
  it("prints the plan prompt and exits before running worker", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("# Roadmap"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("## Phase"))).toBe(true);
  });

  it("expands cli blocks in rendered plan prompt before printing", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).toHaveBeenCalledWith(
      "echo hello",
      cwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "text",
      text: expect.stringContaining("<command>echo hello</command>"),
    });
  });

  it("passes exec timeout to cli block expansion in plan prompt", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    const { dependencies } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      cliBlockTimeoutMs: 1234,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).toHaveBeenCalledWith(
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
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true, ignoreCliBlock: true }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "text",
      text: expect.stringContaining("```cli\necho hello\n```"),
    });
  });

  it("emits an error and aborts when plan template cli block fails", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 6,
        stdout: "",
        stderr: "template failed",
      })),
    };
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "`cli` fenced command failed in plan template (exit 6): echo hello. Aborting run.",
    });
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
  });

  it("renders custom plan templates with vars from vars file and --var", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "# Custom Plan Prompt",
      "Task: {{task}}",
      "File: {{file}}",
      "Scan count: {{scanCount}}",
      "Todos present: {{hasExistingTodos}}",
      "Existing todos: {{existingTodoCount}}",
      "Branch: {{branch}}",
      "Env: {{env}}",
    ].join("\n"));
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({ branch: "main" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 3,
      printPrompt: true,
      varsFileOption: "custom-vars.json",
      cliTemplateVarArgs: ["env=prod"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.templateLoader.load)).toHaveBeenCalledWith(
      expect.stringMatching(/\.rundown[\\/]plan\.md$/),
    );
    expect(vi.mocked(dependencies.templateVarsLoader.load)).toHaveBeenCalledWith(
      "custom-vars.json",
      "/workspace",
      path.join(cwd, ".rundown"),
    );
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("# Custom Plan Prompt");
    expect(prompt).toContain("Task: Roadmap");
    expect(prompt).toContain(`File: ${markdownFile}`);
    expect(prompt).toContain("Scan count: 3");
    expect(prompt).toContain("Todos present: false");
    expect(prompt).toContain("Existing todos: 0");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("Env: prod");
  });

  it("includes memory path and summary in plan prompt without memory body text", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const memoryFilePath = path.join(cwd, ".rundown", "roadmap.memory.md");
    const memoryBodyText = "MEMORY-BODY-SHOULD-NOT-BE-INLINED";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: true,
        filePath: memoryFilePath,
        summary: "Planning history and rollout constraints",
      })),
    };
    vi.mocked(dependencies.templateLoader.load).mockReturnValue(
      "Memory path: {{memoryFilePath}}\nMemory summary: {{memorySummary}}",
    );

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      printPrompt: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("Memory path: " + memoryFilePath);
    expect(prompt).toContain("Memory summary: Planning history and rollout constraints");
    expect(prompt).not.toContain(memoryBodyText);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(markdownFile);
  });

  it("keeps dry-run exit code and behavior when memory metadata is unavailable", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: false,
        filePath: path.join(cwd, ".rundown", "roadmap.memory.md"),
        summary: undefined,
      })),
    };

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run — would plan:"))).toBe(true);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(markdownFile);
  });

  it("keeps core plan template variables authoritative over user vars", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# True Intent\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("Task={{task}}|File={{file}}|Scan={{scanCount}}");
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({
      task: "Injected task",
      file: "Injected file",
      scanCount: "99",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 2,
      printPrompt: true,
      varsFileOption: "custom-vars.json",
      cliTemplateVarArgs: ["task=CLI injected task"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`Task=True Intent|File=${markdownFile}|Scan=2`);
    expect(prompt).not.toContain("Injected task");
    expect(prompt).not.toContain("Injected file");
    expect(prompt).not.toContain("Scan=99");
  });

  it("supports dry-run and skips worker execution", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planning document:"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("No existing TODO items detected"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run"))).toBe(true);
  });

  it("dry-run skips cli block expansion and reports skipped block count", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "info",
      message: "Dry run — skipped `cli` fenced block execution; would execute 1 block.",
    });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run — would plan:"))).toBe(true);
  });

  it("detects existing TODO items before any worker invocation", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\n- [ ] Existing task\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Detected 1 existing TODO item"))).toBe(true);
  });

  it("returns 3 when source markdown cannot be read", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "missing.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "",
      readThrows: true,
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Unable to read Markdown document"))).toBe(true);
  });

  it("returns 1 when source markdown is locked by another process", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.fileLock.acquire).mockImplementation(() => {
      throw new FileLockError(markdownFile, {
        pid: 4321,
        command: "run",
        startTime: "2026-01-01T00:00:00.000Z",
      });
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Source file is locked by another rundown process"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("pid=4321"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("--force-unlock"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("rundown unlock"))).toBe(true);
  });

  it("force-unlocks stale source lock before plan lock acquisition when enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.fileLock.isLocked).mockReturnValue(false);
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, forceUnlock: true }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.isLocked)).toHaveBeenCalledWith(markdownFile);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).toHaveBeenCalledWith(markdownFile);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Force-unlocked stale source lock"))).toBe(true);

    const forceReleaseOrder = vi.mocked(dependencies.fileLock.forceRelease).mock.invocationCallOrder[0];
    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    expect(forceReleaseOrder).toBeLessThan(lockAcquireOrder);
  });

  it("does not force-unlock active source lock when enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.fileLock.isLocked).mockReturnValue(true);
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, forceUnlock: true }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.isLocked)).toHaveBeenCalledWith(markdownFile);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).not.toHaveBeenCalled();
  });

  it("acquires plan file lock before reading source and releases after planner execution", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(markdownFile, { command: "plan" });
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);

    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    const firstReadOrder = vi.mocked(dependencies.fileSystem.readText).mock.invocationCallOrder[0];
    const plannerRunOrder = vi.mocked(workerExecutor.runWorker).mock.invocationCallOrder[0];
    const lockReleaseOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];

    expect(lockAcquireOrder).toBeLessThan(firstReadOrder);
    expect(lockReleaseOrder).toBeGreaterThan(plannerRunOrder);
  });

  it("releases plan file locks when planning completes", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(markdownFile, { command: "plan" });
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("releases plan file locks when planning returns early", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "missing.md");
    const { dependencies } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "",
      readThrows: true,
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(3);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(markdownFile, { command: "plan" });
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("releases plan file locks when planner execution throws", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockRejectedValue(new Error("planner crashed"));

    const planTask = createPlanTask(dependencies);

    await expect(planTask(createOptions({ source: markdownFile }))).rejects.toThrow("planner crashed");
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("returns 1 when worker command is missing", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, workerCommand: [] }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No worker command"))).toBe(true);
  });

  it("rejects opencode continuation args to enforce clean scan sessions", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, workerCommand: ["opencode", "run", "--continue"] }));

    expect(code).toBe(1);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("clean per-scan worker sessions"))).toBe(true);
  });

  it("rejects opencode resume to enforce clean scan sessions", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, workerCommand: ["opencode", "resume"] }));

    expect(code).toBe(1);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("does not allow `opencode resume`"))).toBe(true);
  });

  it("returns execution-failed when planner exits non-zero", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 9, stdout: "", stderr: "boom" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "execution-failed", preserve: true }),
    );
  });

  it("hides planner stderr by default in wait mode", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "planner diagnostic\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "stderr")).toBe(false);
  });

  it("shows planner stderr in wait mode when showAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "planner diagnostic\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, showAgentOutput: true }));

    expect(code).toBe(0);
    expect(events).toContainEqual({ kind: "stderr", text: "planner diagnostic\n" });
  });

  it("completes with warning when planner produces no output", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "   \n", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", preserve: false }),
    );
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Planner produced no output"))).toBe(true);
  });

  it("preserves successful plan artifacts when keepArtifacts is enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, keepArtifacts: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", preserve: true }),
    );
  });

  it("completes with warning when planner output has no task items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "No task list here", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
    expect(events.some((event) => event.kind === "error" && event.message.includes("stdout contract"))).toBe(true);
  });

  it("appends generated TODO items at document end when no TODOs exist", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "## Summary",
      "Build a new release process.",
      "",
      "## Next Steps",
      "Coordinate delivery.",
      "",
      "## Notes",
      "Track decisions.",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "- [ ] Write tests\n- [ ] Update docs\n",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const updated = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(updated).toBe([
      "# Roadmap",
      "",
      "## Summary",
      "Build a new release process.",
      "",
      "## Next Steps",
      "Coordinate delivery.",
      "",
      "## Notes",
      "Track decisions.",
      "",
      "- [ ] Write tests",
      "- [ ] Update docs",
      "",
    ].join("\n"));
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", preserve: false }),
    );
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 2 TODO items"))).toBe(true);
  });

  it("deduplicates TODO items already present in the markdown document", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "- [ ] Existing task\n- [ ] New task\n",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const updated = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(updated).toContain("- [ ] Existing task");
    expect(updated).toContain("- [ ] New task");
    expect(updated.indexOf("- [ ] Existing task")).toBe(updated.lastIndexOf("- [ ] Existing task"));
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("appends missing TODO additions into an existing TODO list", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "## Next Steps",
      "- [ ] Existing task",
      "",
      "## Notes",
      "Keep this untouched.",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Existing task\n- [ ] Add CI pipeline checks\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Existing task\n- [ ] Add CI pipeline checks\n",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const finalSource = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(finalSource).toContain("- [ ] Existing task");
    expect(finalSource).toContain("- [ ] Add CI pipeline checks");
    expect(finalSource.indexOf("- [ ] Existing task")).toBe(finalSource.lastIndexOf("- [ ] Existing task"));
    expect(finalSource).toContain(
      "## Next Steps\n- [ ] Existing task\n- [ ] Add CI pipeline checks\n\n## Notes\nKeep this untouched.\n",
    );
    expect(finalSource).not.toContain("Keep this untouched.\n\n- [ ] Add CI pipeline checks\n");
    expect(events.some((event) => event.kind === "info" && event.message.includes("converged at scan 2"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("runs multiple scan passes until convergence and appends only missing TODO additions", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Write tests\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Write tests\n- [ ] Update docs\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0]?.artifactPhaseLabel).toBe("plan-scan-01");
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.artifactPhaseLabel).toBe("plan-scan-02");
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[2]?.[0]?.artifactPhaseLabel).toBe("plan-scan-03");
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(2);
    const finalSource = vi.mocked(fileSystem.writeText).mock.calls[1]?.[1] ?? "";
    expect(finalSource).toContain("- [ ] Write tests");
    expect(finalSource).toContain("- [ ] Update docs");
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planning plan-scan-01-of-03"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planning plan-scan-03-of-03"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("converged at scan 3"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 2 TODO items"))).toBe(true);
  });

  it("includes clean-session instruction in each scan prompt", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const firstPrompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0]?.prompt ?? "";
    expect(firstPrompt).toContain("clean standalone worker session");
    expect(firstPrompt).toContain("Do not rely on prior prompt history");
    expect(firstPrompt).toContain("Scan label: plan-scan-01-of-01");
  });

  it("uses stable scan input construction with normalized newlines", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\r\nBuild a new release process.";
    const { dependencies, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    const firstPrompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0]?.prompt ?? "";
    expect(firstPrompt).toContain("Current document state (normalized to LF newlines):");
    const fencedSection = firstPrompt.split("```markdown\n")[1]?.split("\n```")[0] ?? "";
    expect(fencedSection).toBe("# Roadmap\nBuild a new release process.\n");
    expect(fencedSection).not.toContain("\r");
  });

  it("stops early when a scan proposes zero valid TODO additions", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Write tests\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Write tests\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Update docs\n",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const finalSource = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(finalSource).toContain("- [ ] Write tests");
    expect(finalSource).not.toContain("- [ ] Update docs");
    expect(events.some((event) => event.kind === "info" && event.message.includes("converged at scan 2"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 TODO item"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 3,
          planScansExecuted: 2,
          planConvergenceOutcome: "converged",
          planConverged: true,
          planScanCapReached: false,
        }),
      }),
    );
  });

  it("stops at scan cap when worker keeps adding TODO items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Scan one\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Scan two\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Scan three\n",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(2);
    const finalSource = vi.mocked(fileSystem.writeText).mock.calls[1]?.[1] ?? "";
    expect(finalSource).toContain("- [ ] Scan one");
    expect(finalSource).toContain("- [ ] Scan two");
    expect(finalSource).not.toContain("- [ ] Scan three");
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 2 TODO items"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 2,
          planScansExecuted: 2,
          planConvergenceOutcome: "scan-cap-reached",
          planConverged: false,
          planScanCapReached: true,
        }),
      }),
    );
  });

  it("fails when planner output attempts non-additive edits to existing TODO lines", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "- [x] Existing task\n- [ ] New task\n",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Only additive TODO operations are allowed"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });

  it("fails when planner output violates strict stdout contract", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "Here are missing tasks:\n- [ ] New task\n",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("stdout contract"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });
});

function createDependencies(options: {
  cwd: string;
  markdownFile: string;
  fileContent: string;
  readThrows?: boolean;
  cliBlockExecutor?: CommandExecutor;
}): {
  dependencies: PlanTaskDependencies;
  events: ApplicationOutputEvent[];
  workerExecutor: PlanTaskDependencies["workerExecutor"];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
} {
  const events: ApplicationOutputEvent[] = [];
  let currentContent = options.fileContent;

  const workerExecutor: PlanTaskDependencies["workerExecutor"] = {
    runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };

  const fileSystem: FileSystem = {
    exists: vi.fn(() => true),
    readText: vi.fn((filePath: string) => {
      if (options.readThrows && filePath === options.markdownFile) {
        throw new Error("missing file");
      }
      if (filePath === options.markdownFile) {
        return currentContent;
      }
      return "";
    }),
    writeText: vi.fn((filePath: string, content: string) => {
      if (filePath === options.markdownFile) {
        currentContent = content;
      }
    }),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-plan",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-plan"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "plan",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-plan")),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn((status) => typeof status === "string" && status.includes("failed")),
  };

  const dependencies: PlanTaskDependencies = {
    workerExecutor,
    workingDirectory: { cwd: vi.fn(() => options.cwd) },
    cliBlockExecutor: options.cliBlockExecutor ?? {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
    },
    fileSystem,
    fileLock: createNoopFileLock(),
    pathOperations: {
      join: vi.fn((...parts: string[]) => parts.join("/")),
      resolve: vi.fn((...parts: string[]) => parts.join("/")),
      dirname: vi.fn((filePath: string) => filePath.split("/").slice(0, -1).join("/") || "/"),
      relative: vi.fn((_from: string, to: string) => to),
      isAbsolute: vi.fn((filePath: string) => filePath.startsWith("/")),
    },
    templateVarsLoader: { load: vi.fn(() => ({})) },
    workerConfigPort: { load: vi.fn(() => undefined) },
    templateLoader: { load: vi.fn(() => null) },
    artifactStore,
    traceWriter: {
      write: vi.fn(),
      flush: vi.fn(),
    },
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
    },
    createTraceWriter: vi.fn((_trace: boolean, _artifactContext) => ({
      write: vi.fn(),
      flush: vi.fn(),
    })),
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    workerExecutor,
    artifactStore,
    fileSystem,
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

function createOptions(overrides: Partial<PlanTaskOptions> = {}): PlanTaskOptions {
  return {
    source: "roadmap.md",
    scanCount: 1,
    mode: "wait",
    transport: "arg",
    showAgentOutput: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    varsFileOption: false,
    cliTemplateVarArgs: [],
    workerCommand: ["opencode", "run"],
    ...overrides,
  };
}
