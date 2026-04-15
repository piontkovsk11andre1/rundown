import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createResearchTask,
  stripIntroducedUncheckedTodos,
  type ResearchTaskDependencies,
  type ResearchTaskOptions,
} from "../../src/application/research-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
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

  it("keeps workspace context template variables authoritative over user vars", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
    ].join("\n"));
    vi.mocked(dependencies.templateVarsLoader.load).mockReturnValue({
      invocationDir: "/fake/file/invocation",
      workspaceDir: "/fake/file/workspace",
      workspaceLinkPath: "/fake/file/workspace.link",
      isLinkedWorkspace: "false",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      varsFileOption: "custom-vars.json",
      cliTemplateVarArgs: [
        "invocationDir=/fake/cli/invocation",
        "workspaceDir=/fake/cli/workspace",
        "workspaceLinkPath=/fake/cli/workspace.link",
        "isLinkedWorkspace=false",
      ],
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/invocation/.rundown/workspace.link",
      isLinkedWorkspace: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`invocationDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain(`workspaceDir=${path.resolve("/real/workspace")}`);
    expect(prompt).toContain(`workspaceLinkPath=${path.resolve("/real/invocation/.rundown/workspace.link")}`);
    expect(prompt).toContain("isLinkedWorkspace=true");
    expect(prompt).not.toContain(path.resolve("/fake/file/invocation"));
    expect(prompt).not.toContain(path.resolve("/fake/cli/invocation"));
  });

  it("emits non-linked workspace context template variables with fallback values", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
    ].join("\n"));

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/invocation/.rundown/workspace.link",
      isLinkedWorkspace: false,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`invocationDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain(`workspaceDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain("workspaceLinkPath=");
    expect(prompt).toContain("isLinkedWorkspace=false");
    expect(prompt).not.toContain(path.resolve("/real/workspace"));
    expect(prompt).not.toContain(path.resolve("/real/invocation/.rundown/workspace.link"));
  });

  it("prefers canonical design/current context over legacy docs/current in research templates", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const canonicalCurrentDir = path.join(cwd, "design", "current");
    const canonicalRevisionDir = path.join(cwd, "design", "rev.1");
    const canonicalTargetFile = path.join(canonicalCurrentDir, "Target.md");
    const legacyCurrentDir = path.join(cwd, "docs", "current");
    const legacyDesignFile = path.join(legacyCurrentDir, "Design.md");
    const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
    const isWorkspacePath = (value: string, ...segments: string[]): boolean => {
      const suffix = normalize("/workspace" + (segments.length > 0 ? "/" + segments.join("/") : ""));
      return normalize(value).endsWith(suffix);
    };

    vi.mocked(dependencies.fileSystem.stat).mockImplementation((filePath: string) => {
      if (isWorkspacePath(filePath, "design", "current")
        || isWorkspacePath(filePath, "design", "rev.1")
        || isWorkspacePath(filePath, "design")
        || isWorkspacePath(filePath, "docs", "current")
        || isWorkspacePath(filePath, "docs")) {
        return { isDirectory: true, isFile: false };
      }

      if (isWorkspacePath(filePath, "design", "current", "Target.md")
        || isWorkspacePath(filePath, "docs", "current", "Design.md")) {
        return { isDirectory: false, isFile: true };
      }

      return null;
    });
    vi.mocked(dependencies.fileSystem.readdir).mockImplementation((dirPath: string) => {
      if (isWorkspacePath(dirPath, "design", "current")) {
        return [{ name: "Target.md", isDirectory: false, isFile: true }];
      }
      if (isWorkspacePath(dirPath, "design")) {
        return [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ];
      }
      if (isWorkspacePath(dirPath, "docs", "current")) {
        return [{ name: "Design.md", isDirectory: false, isFile: true }];
      }
      if (isWorkspacePath(dirPath, "docs")) {
        return [{ name: "current", isDirectory: true, isFile: false }];
      }

      return [];
    });
    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (isWorkspacePath(filePath, "roadmap.md")) {
        return "# Roadmap\nBuild a new release process.\n";
      }
      if (isWorkspacePath(filePath, "design", "current", "Target.md")) {
        return "canonical design";
      }
      if (isWorkspacePath(filePath, "docs", "current", "Design.md")) {
        return "legacy design";
      }

      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "DESIGN={{design}}",
      "SOURCES={{designContextSourceReferences}}",
      "SOURCES_JSON={{designContextSourceReferencesJson}}",
      "HAS_MANAGED={{designContextHasManagedDocs}}",
    ].join("\n"));

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    const normalizedPrompt = prompt.replace(/\\/g, "/");
    expect(normalizedPrompt).toContain("DESIGN=canonical design");
    expect(normalizedPrompt).not.toContain("DESIGN=legacy design");
    expect(normalizedPrompt).toContain("SOURCES=- C:/workspace/design/current\n- C:/workspace/design/rev.1");
    expect(normalizedPrompt).toContain("SOURCES_JSON=");
    expect(normalizedPrompt).toContain("design/current");
    expect(normalizedPrompt).toContain("design/rev.1");
    expect(normalizedPrompt).toContain("HAS_MANAGED=true");
  });

  it("falls back to legacy docs/current design context when canonical design/current is absent", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const legacyCurrentDir = path.join(cwd, "docs", "current");
    const legacyRevisionDir = path.join(cwd, "docs", "rev.1");
    const legacyDesignFile = path.join(legacyCurrentDir, "Design.md");
    const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
    const isWorkspacePath = (value: string, ...segments: string[]): boolean => {
      const suffix = normalize("/workspace" + (segments.length > 0 ? "/" + segments.join("/") : ""));
      return normalize(value).endsWith(suffix);
    };

    vi.mocked(dependencies.fileSystem.stat).mockImplementation((filePath: string) => {
      if (isWorkspacePath(filePath, "docs", "current")
        || isWorkspacePath(filePath, "docs", "rev.1")
        || isWorkspacePath(filePath, "docs")) {
        return { isDirectory: true, isFile: false };
      }
      if (isWorkspacePath(filePath, "docs", "current", "Design.md")) {
        return { isDirectory: false, isFile: true };
      }

      return null;
    });
    vi.mocked(dependencies.fileSystem.readdir).mockImplementation((dirPath: string) => {
      if (isWorkspacePath(dirPath, "docs", "current")) {
        return [{ name: "Design.md", isDirectory: false, isFile: true }];
      }
      if (isWorkspacePath(dirPath, "docs")) {
        return [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ];
      }

      return [];
    });
    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (isWorkspacePath(filePath, "roadmap.md")) {
        return "# Roadmap\nBuild a new release process.\n";
      }
      if (isWorkspacePath(filePath, "docs", "current", "Design.md")) {
        return "legacy design";
      }

      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "DESIGN={{design}}",
      "SOURCES={{designContextSourceReferences}}",
      "SOURCES_JSON={{designContextSourceReferencesJson}}",
      "HAS_MANAGED={{designContextHasManagedDocs}}",
    ].join("\n"));

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    const normalizedPrompt = prompt.replace(/\\/g, "/");
    expect(normalizedPrompt).toContain("DESIGN=legacy design");
    expect(normalizedPrompt).toContain("SOURCES=- C:/workspace/docs/current\n- C:/workspace/docs/rev.1");
    expect(normalizedPrompt).toContain("SOURCES_JSON=");
    expect(normalizedPrompt).toContain("docs/current");
    expect(normalizedPrompt).toContain("docs/rev.1");
    expect(normalizedPrompt).toContain("HAS_MANAGED=true");
  });

  it("falls back to root Design.md in research context when managed workspaces are absent", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const legacyRootDesignPath = path.join(cwd, "Design.md");
    const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
    const isWorkspacePath = (value: string, ...segments: string[]): boolean => {
      const suffix = normalize("/workspace" + (segments.length > 0 ? "/" + segments.join("/") : ""));
      return normalize(value).endsWith(suffix);
    };

    vi.mocked(dependencies.fileSystem.stat).mockImplementation((filePath: string) => {
      if (isWorkspacePath(filePath, "Design.md")) {
        return { isDirectory: false, isFile: true };
      }

      return null;
    });
    vi.mocked(dependencies.fileSystem.readdir).mockReturnValue([]);
    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (isWorkspacePath(filePath, "roadmap.md")) {
        return "# Roadmap\nBuild a new release process.\n";
      }
      if (isWorkspacePath(filePath, "Design.md")) {
        return "legacy root design";
      }

      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "DESIGN={{design}}",
      "SOURCES={{designContextSourceReferences}}",
      "SOURCES_JSON={{designContextSourceReferencesJson}}",
      "HAS_MANAGED={{designContextHasManagedDocs}}",
    ].join("\n"));

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    const normalizedPrompt = prompt.replace(/\\/g, "/");
    expect(normalizedPrompt).toContain("DESIGN=legacy root design");
    expect(normalizedPrompt).toContain("SOURCES=- C:/workspace/Design.md");
    expect(normalizedPrompt).toContain("SOURCES_JSON=");
    expect(normalizedPrompt).toContain("Design.md");
    expect(normalizedPrompt).toContain("HAS_MANAGED=false");
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
    const { dependencies, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile, verbose: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).toHaveBeenCalledWith({
      cwd,
      configDir: path.join(cwd, ".rundown"),
      commandName: "research",
      workerCommand: ["opencode", "run"],
      mode: "wait",
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
      "# Roadmap\nBuild a new release process.\n\n## Enriched\n\nDetails\n",
    );
    expect(events).toContainEqual({
      kind: "info",
      message: "Running research worker: opencode run [mode=wait]",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "Research worker completed (exit 0).",
    });
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
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
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
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
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

  it("strips introduced unchecked TODO items and keeps cleaned research output", async () => {
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

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "warn",
      message: "Research introduced new unchecked TODO items in "
        + markdownFile
        + ". Removed 1 introduced item: - [ ] Add rollout checklist; continuing with cleaned output.",
    });
    expect(events).toContainEqual({ kind: "success", message: "Research worker completed." });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      1,
      markdownFile,
      "# Roadmap\nBuild a new release process.\n\n- [ ] Add rollout checklist\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenNthCalledWith(
      2,
      markdownFile,
      "# Roadmap\nBuild a new release process.\n\n",
    );
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "completed",
        preserve: false,
      }),
    );
  });

  it("fails when research output does not preserve original input content", async () => {
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
      stdout: "Updated the research document body with expanded implementation context.",
      stderr: "",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      message: "Research output did not preserve the original document content. Research must return the full updated Markdown document based on the original input.",
    });
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
  });

  it("strips duplicated introduced unchecked TODO items while preserving existing ones", async () => {
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

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "warn",
      message: "Research introduced new unchecked TODO items in "
        + markdownFile
        + ". Removed 1 introduced item: - [ ] Add rollout checklist; continuing with cleaned output.",
    });
    expect(events).toContainEqual({ kind: "success", message: "Research worker completed." });
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
        status: "completed",
        preserve: false,
      }),
    );
  });

  it("does not strip unchecked TODO lines inside fenced code blocks", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const sourceBefore = "# Roadmap\n\nThin note.\n";
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: sourceBefore,
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "# Roadmap\n\nThin note.\n\n```md\n- [ ] Example task in code block\n```\n",
      stderr: "",
    });

    const researchTask = createResearchTask(dependencies);
    const code = await researchTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("introduced new unchecked TODO items"))).toBe(false);
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledWith(
      markdownFile,
      "# Roadmap\n\nThin note.\n\n```md\n- [ ] Example task in code block\n```\n",
    );
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-research" }),
      expect.objectContaining({
        status: "completed",
        preserve: false,
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

describe("stripIntroducedUncheckedTodos", () => {
  it("removes plain introduced unchecked TODO lines", () => {
    const before = "# Notes\nIntro\n";
    const after = "# Notes\nIntro\n- [ ] Add follow-up\n";

    const result = stripIntroducedUncheckedTodos(before, after);

    expect(result).toEqual({
      cleaned: "# Notes\nIntro\n",
      removed: ["- [ ] Add follow-up"],
    });
  });

  it("keeps pre-existing TODO lines while removing newly introduced duplicates", () => {
    const before = "# Notes\n- [ ] Keep existing\n";
    const after = "# Notes\n- [ ] Keep existing\n- [ ] Keep existing\n";

    const result = stripIntroducedUncheckedTodos(before, after);

    expect(result).toEqual({
      cleaned: "# Notes\n- [ ] Keep existing\n",
      removed: ["- [ ] Keep existing"],
    });
  });

  it("keeps TODO-like lines inside fenced code blocks", () => {
    const before = "# Notes\nIntro\n";
    const after = "# Notes\nIntro\n```md\n- [ ] Example in code\n```\n";

    const result = stripIntroducedUncheckedTodos(before, after);

    expect(result).toEqual({
      cleaned: after,
      removed: [],
    });
  });

  it("handles mixed scenarios of introduced, existing, and fenced TODO lines", () => {
    const before = "# Notes\n- [ ] Existing task\n";
    const after = [
      "# Notes",
      "- [ ] Existing task",
      "- [ ] New task",
      "```md",
      "- [ ] Example in code",
      "```",
      "",
    ].join("\n");

    const result = stripIntroducedUncheckedTodos(before, after);

    expect(result).toEqual({
      cleaned: [
        "# Notes",
        "- [ ] Existing task",
        "```md",
        "- [ ] Example in code",
        "```",
        "",
      ].join("\n"),
      removed: ["- [ ] New task"],
    });
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
    exists: vi.fn((filePath: string) => filePath === options.markdownFile),
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
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: options.fileContent + "\n## Enriched\n\nDetails\n",
        stderr: "",
      })),
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

function createOptions(
  overrides: Partial<ResearchTaskOptions> & { workerCommand?: string[]; transport?: string } = {},
): ResearchTaskOptions {
  const { workerCommand, transport: _transport, ...optionOverrides } = overrides;
  void _transport;

  return {
    source: "roadmap.md",
    mode: "wait",
    workerPattern: inferWorkerPatternFromCommand(workerCommand ?? ["opencode", "run"]),
    showAgentOutput: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: false,
    cliTemplateVarArgs: [],
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    configDirOption: undefined,
    ...optionOverrides,
  };
}
