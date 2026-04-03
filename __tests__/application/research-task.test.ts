import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createResearchTask,
  type ResearchTaskDependencies,
  type ResearchTaskOptions,
} from "../../src/application/research-task.js";
import type {
  ArtifactStore,
  ApplicationOutputEvent,
  CommandExecutor,
  FileLock,
  FileSystem,
} from "../../src/domain/ports/index.js";
import { FileLockError } from "../../src/domain/ports/file-lock.js";

describe("research-task", () => {
  it("renders custom research templates with vars from vars file and --var", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "# Custom Research Prompt",
      "Task: {{task}}",
      "File: {{file}}",
      "Context: {{context}}",
      "Source: {{source}}",
      "Branch: {{branch}}",
      "Env: {{env}}",
    ].join("\n"));
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({ branch: "main" });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      varsFileOption: "custom-vars.json",
      cliTemplateVarArgs: ["env=prod"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.templateLoader.load)).toHaveBeenCalledWith(
      expect.stringMatching(/\.rundown[\\/]research\.md$/),
    );
    expect(vi.mocked(dependencies.templateVarsLoader.load)).toHaveBeenCalledWith(
      "custom-vars.json",
      cwd,
      path.join(cwd, ".rundown"),
    );
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("# Custom Research Prompt");
    expect(prompt).toContain("Task: Roadmap");
    expect(prompt).toContain(`File: ${markdownFile}`);
    expect(prompt).toContain("Context: # Roadmap");
    expect(prompt).toContain("Source: # Roadmap");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("Env: prod");
  });

  it("includes memory path and summary in research prompt without memory body text", async () => {
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
        summary: "Research findings and architecture notes",
      })),
    };
    vi.mocked(dependencies.templateLoader.load).mockReturnValue(
      "Memory path: {{memoryFilePath}}\nMemory summary: {{memorySummary}}",
    );

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      printPrompt: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("Memory path: " + memoryFilePath);
    expect(prompt).toContain("Memory summary: Research findings and architecture notes");
    expect(prompt).not.toContain(memoryBodyText);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(markdownFile);
  });

  it("keeps dry-run exit code and behavior when memory metadata is unavailable", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, artifactStore } = createDependencies({
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

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events).toContainEqual({ kind: "info", message: "Dry run - would research: opencode run" });
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(markdownFile);
  });

  it("keeps core research template variables authoritative over user vars", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# True Intent\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("Task={{task}}|File={{file}}|Source={{source}}");
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({
      task: "Injected task",
      file: "Injected file",
      source: "Injected source",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      varsFileOption: "custom-vars.json",
      cliTemplateVarArgs: ["task=CLI injected task"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`Task=True Intent|File=${markdownFile}|Source=# True Intent\nBuild a new release process.\n`);
    expect(prompt).not.toContain("Injected task");
    expect(prompt).not.toContain("Injected file");
    expect(prompt).not.toContain("Injected source");
  });

  it("reports dry-run details without executing research worker", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events).toContainEqual({ kind: "info", message: "Dry run - would research: opencode run" });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt length:"))).toBe(true);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.acquire)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.releaseAll)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
  });

  it("expands cli blocks in rendered research prompt before printing", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, printPrompt: true }));

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
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.acquire)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.releaseAll)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
  });

  it("passes exec timeout to cli block expansion in research prompt", async () => {
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

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
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
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, printPrompt: true, ignoreCliBlock: true }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "text",
      text: "```cli\necho hello\n```",
    });
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).not.toHaveBeenCalled();
  });

  it("emits an error and aborts when research template cli block fails", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 6,
        stdout: "",
        stderr: "template failed",
      })),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "`cli` fenced command failed in research template (exit 6): echo hello. Aborting run.",
    });
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
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("```cli\necho hello\n```");

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "info",
      message: "Dry run — skipped `cli` fenced block execution; would execute 1 block.",
    });
    expect(events).toContainEqual({ kind: "info", message: "Dry run - would research: opencode run" });
  });

  it("acquires research file lock before reading source, runs worker once, and releases lock", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).toHaveBeenCalledWith({
      cwd,
      configDir: path.join(cwd, ".rundown"),
      commandName: "research",
      workerCommand: ["opencode", "run"],
      mode: "wait",
      transport: "arg",
      source: markdownFile,
      keepArtifacts: false,
    });
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(markdownFile, { command: "research" });
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledWith(expect.objectContaining({
      artifactContext: expect.objectContaining({ runId: "run-research" }),
      artifactPhase: "worker",
      artifactPhaseLabel: "research",
    }));
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledWith(
      markdownFile,
      "# Enriched\n\nDetails\n",
    );
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "completed",
        preserve: false,
      }),
    );
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);

    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    const firstReadOrder = vi.mocked(dependencies.fileSystem.readText).mock.invocationCallOrder[0];
    const workerRunOrder = vi.mocked(dependencies.workerExecutor.runWorker).mock.invocationCallOrder[0];
    const lockReleaseOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];

    expect(lockAcquireOrder).toBeLessThan(firstReadOrder);
    expect(lockReleaseOrder).toBeGreaterThan(workerRunOrder);
  });

  it("routes tui mode through interactive worker execution with output capture", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      mode: "tui",
      transport: "file",
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledWith(expect.objectContaining({
      mode: "tui",
      transport: "file",
      captureOutput: true,
    }));
  });

  it("rejects research output that changes checkbox state and restores original source", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const sourceBefore = "# Roadmap\n- [x] Existing complete item\n";
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: sourceBefore,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "# Roadmap\n- [ ] Existing complete item\n",
      stderr: "",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "Research changed checkbox state in "
        + markdownFile
        + ". Research may enrich prose, but must not mark/unmark checkboxes.",
    });
    expect(events).toContainEqual({
      kind: "error",
      message: "Research update rejected due to constraint violation.",
    });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
      markdownFile,
      "# Roadmap\n- [ ] Existing complete item\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      2,
      markdownFile,
      sourceBefore,
    );
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
  });

  it("rejects research output that removes existing checkbox lines and restores original source", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const sourceBefore = "# Roadmap\n- [x] Existing complete item\n";
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: sourceBefore,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "# Roadmap\nExisting complete item\n",
      stderr: "",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "Research changed checkbox state in "
        + markdownFile
        + ". Research may enrich prose, but must not mark/unmark checkboxes.",
    });
    expect(events).toContainEqual({
      kind: "error",
      message: "Research update rejected due to constraint violation.",
    });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
      markdownFile,
      "# Roadmap\nExisting complete item\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      2,
      markdownFile,
      sourceBefore,
    );
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
  });

  it("rejects research output that introduces unchecked TODO items and restores original source", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const sourceBefore = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: sourceBefore,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "# Roadmap\nBuild a new release process.\n\n- [ ] Add rollout checklist\n",
      stderr: "",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "Research introduced new unchecked TODO items in "
        + markdownFile
        + ". Research may enrich prose, but must not add `- [ ]` tasks.",
    });
    expect(events).toContainEqual({
      kind: "error",
      message: "Research update rejected due to constraint violation.",
    });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
      markdownFile,
      "# Roadmap\nBuild a new release process.\n\n- [ ] Add rollout checklist\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      2,
      markdownFile,
      sourceBefore,
    );
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
  });

  it("rejects research output that duplicates an existing unchecked TODO item", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const sourceBefore = "# Roadmap\n\n- [ ] Add rollout checklist\n";
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: sourceBefore,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "# Roadmap\n\n- [ ] Add rollout checklist\n- [ ] Add rollout checklist\n",
      stderr: "",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "Research introduced new unchecked TODO items in "
        + markdownFile
        + ". Research may enrich prose, but must not add `- [ ]` tasks.",
    });
    expect(events).toContainEqual({
      kind: "error",
      message: "Research update rejected due to constraint violation.",
    });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
      markdownFile,
      "# Roadmap\n\n- [ ] Add rollout checklist\n- [ ] Add rollout checklist\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      2,
      markdownFile,
      sourceBefore,
    );
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
  });

  it("returns 1 when source markdown is locked by another process", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
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

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Source file is locked by another rundown process"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("pid=4321"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("--force-unlock"))).toBe(true);
  });

  it("emits restoration failure details when constraint rejection cannot restore source", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const sourceBefore = "# Roadmap\n- [x] Existing complete item\n";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: sourceBefore,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "# Roadmap\n- [ ] Existing complete item\n",
      stderr: "",
    });
    vi.mocked(dependencies.fileSystem.writeText)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "Research changed checkbox state in "
        + markdownFile
        + ". Research may enrich prose, but must not mark/unmark checkboxes.",
    });
    expect(events).toContainEqual({
      kind: "error",
      message: "Research constraint violation detected, but failed to restore original Markdown document: " + markdownFile,
    });
    expect(events).toContainEqual({
      kind: "error",
      message: "Research update rejected due to constraint violation.",
    });
  });

  it("releases research file lock when worker execution fails", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 7,
      stdout: "",
      stderr: "research failed",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, showAgentOutput: true }));

    expect(code).toBe(1);
    expect(events).toContainEqual({ kind: "stderr", text: "research failed" });
    expect(events).toContainEqual({ kind: "error", message: "Research worker exited with code 7." });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at"))).toBe(true);
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("preserves artifacts on success when keepArtifacts is enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      keepArtifacts: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "completed",
        preserve: true,
      }),
    );
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at"))).toBe(true);
  });
});

function createDependencies(options: {
  cwd: string;
  markdownFile: string;
  fileContent: string;
  readThrows?: boolean;
  cliBlockExecutor?: CommandExecutor;
}): {
  dependencies: ResearchTaskDependencies;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
} {
  const events: ApplicationOutputEvent[] = [];

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-research",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-research"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "research",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-research")),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn((status) => typeof status === "string" && status.includes("failed")),
  };

  const fileSystem: FileSystem = {
    exists: vi.fn(() => true),
    readText: vi.fn((filePath: string) => {
      if (options.readThrows && filePath === options.markdownFile) {
        throw new Error("missing file");
      }
      if (filePath === options.markdownFile) {
        return options.fileContent;
      }
      return "";
    }),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const dependencies: ResearchTaskDependencies = {
    workerExecutor: {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "# Enriched\n\nDetails\n", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
    cliBlockExecutor: options.cliBlockExecutor ?? {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
    },
    artifactStore,
    fileSystem,
    fileLock: createNoopFileLock(),
    workingDirectory: { cwd: vi.fn(() => options.cwd) },
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    templateLoader: { load: vi.fn(() => null) },
    templateVarsLoader: { load: vi.fn(() => ({})) },
    workerConfigPort: { load: vi.fn(() => undefined) },
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    artifactStore,
    fileSystem,
  };
}

function createNoopFileLock(): FileLock {
  return {
    acquire: vi.fn(),
    isLocked: vi.fn(() => false),
    release: vi.fn(),
    forceRelease: vi.fn(),
    releaseAll: vi.fn(),
  };
}

function createOptions(overrides: Partial<ResearchTaskOptions> = {}): ResearchTaskOptions {
  return {
    source: "roadmap.md",
    mode: "wait",
    transport: "arg",
    showAgentOutput: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: false,
    cliTemplateVarArgs: [],
    workerCommand: ["opencode", "run"],
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    configDirOption: undefined,
    ...overrides,
  };
}
