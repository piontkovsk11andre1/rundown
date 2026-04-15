import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPlanTask, type PlanTaskDependencies, type PlanTaskOptions } from "../../src/application/plan-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
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
    expect(events.some((event) => event.kind === "text" && event.text.includes("Document source is intentionally omitted for plan scans"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes(markdownFile))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("## Phase"))).toBe(true);
  });

  it("includes max-items budget guidance in printed scan prompt", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      maxItems: 3,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("Max-items cap: 3. Already added: 0. Remaining item budget: 3.");
    expect(prompt).toContain("Add at most 3 new TODO items in this scan; if no budget remains, leave the file unchanged.");
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

  it("renders a fallback scanCount template value in unlimited mode", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockReturnValue("Scan count: {{scanCount}}");

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: undefined,
      printPrompt: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("Scan count: unlimited (emergency cap: 15)");
  });

  it("loads optional planner prepend/append guidance from the resolved config directory", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const markdownContent = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: markdownContent,
    });
    const prependPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-prepend.md");
    const appendPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-append.md");

    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath === markdownFile) {
        return markdownContent;
      }
      if (filePath === prependPath) {
        return "Prefer early discovery and setup checks.";
      }
      if (filePath === appendPath) {
        return "Prefer final verification and handoff tasks when relevant.";
      }
      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "prepend={{planPrependGuidance}}",
      "append={{planAppendGuidance}}",
    ].join("\n"));

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("prepend=Prefer early discovery and setup checks.");
    expect(prompt).toContain("append=Prefer final verification and handoff tasks when relevant.");
  });

  it("treats missing, unreadable, or empty planner guidance files as empty values", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const markdownContent = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: markdownContent,
    });
    const prependPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-prepend.md");
    const appendPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-append.md");

    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath === markdownFile) {
        return markdownContent;
      }
      if (filePath === prependPath) {
        throw new Error("unreadable");
      }
      if (filePath === appendPath) {
        return "   \n\t  ";
      }
      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "prepend=|{{planPrependGuidance}}|",
      "append=|{{planAppendGuidance}}|",
    ].join("\n"));

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("prepend=||");
    expect(prompt).toContain("append=||");
  });

  it("uses empty prepend guidance when only append guidance exists", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const markdownContent = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: markdownContent,
    });
    const prependPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-prepend.md");
    const appendPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-append.md");

    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath === markdownFile) {
        return markdownContent;
      }
      if (filePath === prependPath) {
        throw new Error("missing file");
      }
      if (filePath === appendPath) {
        return "Prefer final verification and handoff tasks when relevant.";
      }
      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "prepend=|{{planPrependGuidance}}|",
      "append=|{{planAppendGuidance}}|",
    ].join("\n"));

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("prepend=||");
    expect(prompt).toContain("append=|Prefer final verification and handoff tasks when relevant.|");
  });

  it("uses empty append guidance when only prepend guidance exists", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const markdownContent = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: markdownContent,
    });
    const prependPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-prepend.md");
    const appendPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-append.md");

    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath === markdownFile) {
        return markdownContent;
      }
      if (filePath === prependPath) {
        return "Prefer early discovery and setup checks.";
      }
      if (filePath === appendPath) {
        throw new Error("missing file");
      }
      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "prepend=|{{planPrependGuidance}}|",
      "append=|{{planAppendGuidance}}|",
    ].join("\n"));

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("prepend=|Prefer early discovery and setup checks.|");
    expect(prompt).toContain("append=||");
  });

  it("keeps custom plan templates backward compatible when guidance placeholders are absent", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const markdownContent = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: markdownContent,
    });
    const prependPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-prepend.md");
    const appendPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-append.md");

    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath === markdownFile) {
        return markdownContent;
      }
      if (filePath === prependPath) {
        return "Prefer early setup checks.";
      }
      if (filePath === appendPath) {
        return "Prefer final validation tasks.";
      }
      return "";
    });
    vi.mocked(dependencies.templateLoader.load).mockReturnValue([
      "# Custom Plan Prompt",
      "Task={{task}}",
      "File={{file}}",
    ].join("\n"));

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("# Custom Plan Prompt");
    expect(prompt).toContain("Task=Roadmap");
    expect(prompt).toContain(`File=${markdownFile}`);
    expect(prompt).not.toContain("Prefer early setup checks.");
    expect(prompt).not.toContain("Prefer final validation tasks.");
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

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
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
    expect(prompt).toContain("invocationDir=/real/invocation");
    expect(prompt).toContain("workspaceDir=/real/workspace");
    expect(prompt).toContain("workspaceLinkPath=/real/invocation/.rundown/workspace.link");
    expect(prompt).toContain("isLinkedWorkspace=true");
    expect(prompt).not.toContain("/fake/file/");
    expect(prompt).not.toContain("/fake/cli/");
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

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/invocation/.rundown/workspace.link",
      isLinkedWorkspace: false,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("invocationDir=/real/invocation");
    expect(prompt).toContain("workspaceDir=/real/invocation");
    expect(prompt).toContain("workspaceLinkPath=");
    expect(prompt).toContain("isLinkedWorkspace=false");
    expect(prompt).not.toContain("/real/workspace");
    expect(prompt).not.toContain("/real/invocation/.rundown/workspace.link");
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
    expect(events.some((event) => event.kind === "info" && event.message.includes("No existing TODO items found in document"))).toBe(true);
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

  it("prints deep prompts in --print-prompt mode without executing deep workers", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\n- [ ] Parent with child\n  - [ ] Existing child\n- [ ] Leaf parent\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, printPrompt: true, deep: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    const textEvents = events.filter((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text");
    expect(textEvents.some((event) => event.text.includes("## Scan Context"))).toBe(true);
    expect(textEvents.some((event) => event.text.includes("## Parent task context"))).toBe(true);
    expect(textEvents.some((event) => event.text.includes("Parent task: Leaf parent"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("pass 1 only"))).toBe(true);
  });

  it("reports deep-pass dry-run plan without executing worker", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\n- [ ] Leaf parent\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, dryRun: true, deep: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Deep count: 2"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("would run deep pass 1 of 2 for 1 parent task"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Deep prompt length (first parent task):"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("passes 2..2 depend on child TODO additions"))).toBe(true);
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

  it("ignores trace-statistics subItems when counting existing TODO items for scan context", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor } = createDependencies({
      cwd,
      markdownFile,
      fileContent: [
        "# Roadmap",
        "- [x] Completed setup",
        "  - total time: 5s",
        "    - execution: 2s",
        "  - tokens estimated: 42",
        "- [ ] Remaining task",
      ].join("\n"),
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Detected 2 existing TODO items"))).toBe(true);
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
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Planner made no file edits"))).toBe(true);
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

  it("completes when planner leaves file unchanged even with stdout text", async () => {
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

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", preserve: false }),
    );
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Planner made no file edits"))).toBe(true);
  });

  it("accepts direct file edits that add TODO items at document end", async () => {
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

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, [
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
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    const updated = fileSystem.readText(markdownFile);
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

  it("counts only newly added unchecked TODO items from direct edits", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Existing task\n- [ ] New task\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(0);
    const updated = fileSystem.readText(markdownFile);
    expect(updated).toContain("- [ ] Existing task");
    expect(updated).toContain("- [ ] New task");
    expect(updated.indexOf("- [ ] Existing task")).toBe(updated.lastIndexOf("- [ ] Existing task"));
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("converges when worker leaves file unchanged on a later scan", async () => {
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
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "",
          "## Next Steps",
          "- [ ] Existing task",
          "- [ ] Add CI pipeline checks",
          "",
          "## Notes",
          "Keep this untouched.",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Existing task");
    expect(finalSource).toContain("- [ ] Add CI pipeline checks");
    expect(finalSource.indexOf("- [ ] Existing task")).toBe(finalSource.lastIndexOf("- [ ] Existing task"));
    expect(finalSource).toContain(
      "## Next Steps\n- [ ] Existing task\n\n## Notes\nKeep this untouched.\n\n- [ ] Add CI pipeline checks\n",
    );
    expect(finalSource).not.toContain("- [ ] Existing task\n- [ ] Add CI pipeline checks");
    expect(events.some((event) => event.kind === "info" && event.message.includes("converged at scan 2"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("runs multiple scan passes until worker file edits converge", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Write tests\n- [ ] Update docs\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Write tests\n- [ ] Update docs\n- [ ] Prepare release notes\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3, verbose: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0]?.artifactPhaseLabel).toBe("plan-scan-01");
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.artifactPhaseLabel).toBe("plan-scan-02");
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[2]?.[0]?.artifactPhaseLabel).toBe("plan-scan-03");
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Write tests");
    expect(finalSource).toContain("- [ ] Update docs");
    expect(finalSource).toContain("- [ ] Prepare release notes");
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planning plan-scan-01-of-03"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Executing planner plan-scan-01-of-03"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planner plan-scan-01-of-03 completed (exit 0)."))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planning plan-scan-03-of-03"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Executing planner plan-scan-03-of-03"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planner plan-scan-03-of-03 completed (exit 0)."))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("converged at scan 3"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 3 TODO items"))).toBe(true);
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
    expect(firstPrompt).toContain("Avoid cosmetic rewrites");
    expect(firstPrompt).toContain("genuinely missing actionable TODO items");
    expect(firstPrompt).toContain("If plan coverage is already sufficient, leave the file unchanged.");
    expect(firstPrompt).toContain("Scan label: plan-scan-01-of-01");
    expect(firstPrompt).toContain("## Rundown feature reference for planning");
    expect(firstPrompt).toContain("`verify:` skips execution and runs only the verification phase");
    expect(firstPrompt).toContain("`fast:` executes the task but skips the verification phase entirely");
    expect(firstPrompt).toContain("`profile=<name>`");
    expect(firstPrompt).toContain("`memory:` for research/context-capture tasks that gather reusable context for later steps");
    expect(firstPrompt).toContain("there is no explicit target file write/edit/create in that task");
    expect(firstPrompt).toContain("Do NOT use `memory:` when the task asks to write/edit/create/update any file");
    expect(firstPrompt).toContain("Explicit write-target examples that must remain normal execution TODOs");
    expect(firstPrompt).toContain("- [ ] Write findings to docs/research-notes.md");
    expect(firstPrompt).toContain("- [ ] Research rollout risks and write findings into docs/rollout-plan.md");
    expect(firstPrompt).toContain("research and write findings into X.md");
    expect(firstPrompt).toContain("split into separate TODOs when possible");
    expect(firstPrompt).toContain("Author new memory-capture TODOs with the canonical `memory:` prefix only");
    expect(firstPrompt).toContain("`include: <path>`");
    expect(firstPrompt).toContain("Prefix composition is supported with `, ` or `; ` separators");
  });

  it("describes unknown total pass count in unlimited scan prompts", async () => {
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
    const code = await planTask(createOptions({ source: markdownFile, scanCount: undefined }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const firstPrompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0]?.prompt ?? "";
    expect(firstPrompt).toContain("Scan label: plan-scan-01");
    expect(firstPrompt).toContain("Scan pass 1 (unlimited mode; total pass count is unknown).");
  });

  it("omits max-items guidance when no max-items cap is set", async () => {
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
    const code = await planTask(createOptions({ source: markdownFile, maxItems: undefined }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const firstPrompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0]?.prompt ?? "";
    expect(firstPrompt).not.toContain("Max-items cap:");
    expect(firstPrompt).not.toContain("Remaining item budget:");
    expect(firstPrompt).not.toContain("Add at most");
  });

  it("builds scan prompt with source-file edit context", async () => {
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
    expect(firstPrompt).toContain("Edit the source file directly at:");
    expect(firstPrompt).toContain(markdownFile);
    expect(firstPrompt).not.toContain("Build a new release process.");
    expect(firstPrompt).not.toContain("Current document state (normalized to LF newlines):");
  });

  it("stops early when a later scan leaves the file unchanged", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Write tests\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Write tests\n- [ ] Update docs\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Write tests");
    expect(finalSource).not.toContain("- [ ] Update docs");
    expect(events.some((event) => event.kind === "info" && event.message.includes("converged at scan 2"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-no-change.",
    });
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 TODO item"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 3,
          planScansExecuted: 2,
          planConvergenceReason: "converged-no-change",
          planConvergenceOutcome: "converged-no-change",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
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
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n- [ ] Scan two\n- [ ] Scan three\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n- [ ] Scan two\n- [ ] Scan three\n- [ ] Scan four\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Scan one");
    expect(finalSource).toContain("- [ ] Scan two");
    expect(finalSource).toContain("- [ ] Scan three");
    expect(finalSource).not.toContain("- [ ] Scan four");
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: scan-cap-reached.",
    });
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 3 TODO items"))).toBe(true);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 2,
          planScansExecuted: 2,
          planConvergenceReason: "scan-cap-reached",
          planConvergenceOutcome: "scan-cap-reached",
          planConverged: false,
          planScanCapReached: true,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("accepts final scan overshoot when max-items is reached", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "Build a new release process.",
          "- [ ] Item one",
          "- [ ] Item two",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "Build a new release process.",
          "- [ ] Item one",
          "- [ ] Item two",
          "- [ ] Should not be added",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 5,
      maxItems: 1,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Item one");
    expect(finalSource).toContain("- [ ] Item two");
    expect(finalSource).not.toContain("- [ ] Should not be added");
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("max-items cap reached")
      && event.message.includes("2/1 TODO items added"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: max-items-reached.",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan operation summary: 1 success, 0 failures. Planning stopped because --max-items limit was reached.",
    });
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 2 TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 5,
          planScansExecuted: 1,
          planConvergenceReason: "max-items-reached",
          planConvergenceOutcome: "max-items-reached",
          planConverged: false,
          planMaxItemsReached: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("stops scan loop when insertedTotal equals max-items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "Build a new release process.",
          "- [ ] Item one",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "Build a new release process.",
          "- [ ] Item one",
          "- [ ] Should not be added",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 5,
      maxItems: 1,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Item one");
    expect(finalSource).not.toContain("- [ ] Should not be added");
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("after scan 1")
      && event.message.includes("1/1 TODO items added"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: max-items-reached.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 5,
          planScansExecuted: 1,
          planConvergenceReason: "max-items-reached",
          planConvergenceOutcome: "max-items-reached",
          planConverged: false,
          planMaxItemsReached: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("stops unlimited scanning when max-items is reached", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "Build a new release process.",
          "- [ ] Item one",
          "- [ ] Item two",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "Build a new release process.",
          "- [ ] Item one",
          "- [ ] Item two",
          "- [ ] Should not be added",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: undefined,
      maxItems: 1,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Item one");
    expect(finalSource).toContain("- [ ] Item two");
    expect(finalSource).not.toContain("- [ ] Should not be added");
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("max-items cap reached")
      && event.message.includes("2/1 TODO items added"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: max-items-reached.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: null,
          planScansExecuted: 1,
          planConvergenceReason: "max-items-reached",
          planConvergenceOutcome: "max-items-reached",
          planConverged: false,
          planMaxItemsReached: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("prefers max-items stop over semantic convergence when both apply", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 3,
      maxItems: 0,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("before scan 1")
      && event.message.includes("0/0 TODO items added"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: max-items-reached.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 3,
          planScansExecuted: 0,
          planConvergenceReason: "max-items-reached",
          planConvergenceOutcome: "max-items-reached",
          planConverged: false,
          planMaxItemsReached: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("records max-items convergence distinctly in run.completed trace payload", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };
    vi.mocked(dependencies.createTraceWriter).mockReturnValue(traceWriter);

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, [
        "# Roadmap",
        "Build a new release process.",
        "- [ ] Item one",
        "- [ ] Item two",
        "",
      ].join("\n"));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 5,
      maxItems: 1,
      trace: true,
    }));

    expect(code).toBe(0);
    const runCompletedEvent = traceWriter.write.mock.calls
      .map((call) => call[0])
      .find((event) => event.event_type === "run.completed");
    expect(runCompletedEvent).toBeDefined();
    expect(runCompletedEvent?.payload).toEqual(expect.objectContaining({
      status: "completed",
      plan_convergence_outcome: "max-items-reached",
      plan_converged: false,
      plan_max_items_reached: true,
      plan_scan_cap_reached: false,
      plan_emergency_cap_reached: false,
    }));
  });

  it("stops unlimited scanning at internal emergency cap", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    let runCount = 0;
    vi.mocked(workerExecutor.runWorker).mockImplementation(async () => {
      runCount += 1;
      const todos = Array.from({ length: runCount * 2 }, (_value, index) => `- [ ] Scan ${index + 1}`).join("\n");
      fileSystem.writeText(markdownFile, `# Roadmap\nBuild a new release process.\n${todos}\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: undefined }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(15);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Scan 30");
    expect(finalSource).not.toContain("- [ ] Scan 31");
    expect(events.some((event) => event.kind === "warn"
      && event.message.includes("Emergency scan ceiling reached")
      && event.message.includes("non-fatal safety stop"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: emergency-cap-reached.",
    });
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: null,
          planScansExecuted: 15,
          planConvergenceReason: "emergency-cap-reached",
          planConvergenceOutcome: "emergency-cap-reached",
          planConverged: false,
          planScanCapReached: false,
          planEmergencyCapReached: true,
        }),
      }),
    );
  });

  it("keeps emergency cap as fallback when max-items is configured", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    let runCount = 0;
    vi.mocked(workerExecutor.runWorker).mockImplementation(async () => {
      runCount += 1;
      const todos = Array.from({ length: runCount * 2 }, (_value, index) => `- [ ] Scan ${index + 1}`).join("\n");
      fileSystem.writeText(markdownFile, `# Roadmap\nBuild a new release process.\n${todos}\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: undefined,
      maxItems: 1_000,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(15);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Scan 30");
    expect(finalSource).not.toContain("- [ ] Scan 31");
    expect(events.some((event) => event.kind === "warn"
      && event.message.includes("Emergency scan ceiling reached")
      && event.message.includes("non-fatal safety stop"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: emergency-cap-reached.",
    });
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("Plan stop reason: max-items-reached."))).toBe(false);
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: null,
          planScansExecuted: 15,
          planConvergenceReason: "emergency-cap-reached",
          planConvergenceOutcome: "emergency-cap-reached",
          planConverged: false,
          planMaxItemsReached: false,
          planScanCapReached: false,
          planEmergencyCapReached: true,
        }),
      }),
    );
  });

  it("reports converged-no-additions when edits change non-TODO content only", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "- [ ] Existing task A",
      "- [ ] Existing task B",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, [
        "# Updated roadmap",
        "",
        "- [ ] Existing task A",
        "- [ ] Existing task B",
        "",
      ].join("\n"));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-no-additions.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planConvergenceReason: "converged-no-additions",
          planConvergenceOutcome: "converged-no-additions",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("converges as rewrite-only and reverts file when worker rewords items without net new TODOs", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "- [ ] Fix bug",
      "- [ ] Add tests",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, [
        "# Roadmap",
        "",
        "- [ ] Fix the critical bug",
        "- [ ] Add tests",
        "",
      ].join("\n"));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const modifiedContent = [
      "# Roadmap",
      "",
      "- [ ] Fix the critical bug",
      "- [ ] Add tests",
      "",
    ].join("\n");
    expect(fileSystem.readText(markdownFile)).toBe(modifiedContent);
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("converged at scan 1")
      && event.message.includes("edit added no new TODO items"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-no-additions.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planConvergenceReason: "converged-no-additions",
          planConvergenceOutcome: "converged-no-additions",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("converges as rewrite-only and reverts file when worker reorders items without net new TODOs", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "- [ ] Existing task A",
      "- [ ] Existing task B",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, [
        "# Roadmap",
        "",
        "- [ ] Existing task B",
        "- [ ] Existing task A",
        "",
      ].join("\n"));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(fileSystem.readText(markdownFile)).toBe(content);
    expect(events.some((event) => event.kind === "warn"
      && event.message.includes("without net additions")
      && event.message.includes("File reverted"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-rewrite-only.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planConvergenceReason: "converged-rewrite-only",
          planConvergenceOutcome: "converged-rewrite-only",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("continues scanning when worker adds three TODO identities and rewords one existing item (net additions = 2)", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "- [ ] Fix bug",
      "- [ ] Add tests",
      "",
    ].join("\n");
    const firstScanEdit = [
      "# Roadmap",
      "",
      "- [ ] Fix the critical bug",
      "- [ ] Add tests",
      "- [ ] Add regression tests",
      "- [ ] Update release notes",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, firstScanEdit);
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 4 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(fileSystem.readText(markdownFile)).toBe(firstScanEdit);
    expect(events.some((event) => event.kind === "warn"
      && event.message.includes("without net additions")
      && event.message.includes("File reverted"))).toBe(false);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-no-change.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 4,
          planScansExecuted: 2,
          planConvergenceReason: "converged-no-change",
          planConvergenceOutcome: "converged-no-change",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("records semantic convergence before hitting max-items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "- [ ] Existing task A",
      "- [ ] Existing task B",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, [
        "# Roadmap",
        "",
        "- [ ] Existing task B",
        "- [ ] Existing task A",
        "",
      ].join("\n"));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 5,
      maxItems: 10,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-rewrite-only.",
    });
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("Plan stop reason: max-items-reached."))).toBe(false);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planConvergenceReason: "converged-rewrite-only",
          planConvergenceOutcome: "converged-rewrite-only",
          planConverged: true,
          planMaxItemsReached: false,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("records bounded scan-cap convergence distinctly in run.completed trace payload", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };
    vi.mocked(dependencies.createTraceWriter).mockReturnValue(traceWriter);

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n- [ ] Scan two\n- [ ] Scan three\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      scanCount: 2,
      trace: true,
    }));

    expect(code).toBe(0);
    const runCompletedEvent = traceWriter.write.mock.calls
      .map((call) => call[0])
      .find((event) => event.event_type === "run.completed");
    expect(runCompletedEvent).toBeDefined();
    expect(runCompletedEvent?.payload).toEqual(expect.objectContaining({
      status: "completed",
      plan_convergence_outcome: "scan-cap-reached",
      plan_converged: false,
      plan_max_items_reached: false,
      plan_scan_cap_reached: true,
      plan_emergency_cap_reached: false,
    }));
  });

  it("stops unlimited scanning on semantic convergence with no net new TODO items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "",
      "## Next Steps",
      "- [ ] Existing task A",
      "- [ ] Existing task B",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "",
          "## Next Steps",
          "- [ ] Existing task B",
          "- [ ] Existing task A",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "",
          "## Next Steps",
          "- [ ] Existing task B",
          "- [ ] Existing task A",
          "- [ ] Should not be added",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: undefined }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).not.toContain("Should not be added");
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-rewrite-only.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: null,
          planScansExecuted: 1,
          planConvergenceReason: "converged-rewrite-only",
          planConvergenceOutcome: "converged-rewrite-only",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("converges on diminishing returns after two consecutive low-addition scans", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n- [ ] Scan two\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Scan one\n- [ ] Scan two\n- [ ] Scan three\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: 5 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Scan one");
    expect(finalSource).toContain("- [ ] Scan two");
    expect(finalSource).not.toContain("- [ ] Scan three");
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("diminishing returns"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-diminishing.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: 5,
          planScansExecuted: 2,
          planConvergenceReason: "converged-diminishing",
          planConvergenceOutcome: "converged-diminishing",
          planConverged: true,
          planMaxItemsReached: false,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("converges in unlimited mode after two consecutive scans that each add exactly one item", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\nBuild a new release process.\n";
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Added in scan one\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Added in scan one\n- [ ] Added in scan two\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\nBuild a new release process.\n- [ ] Added in scan one\n- [ ] Added in scan two\n- [ ] Should not be added\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: undefined }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Added in scan one");
    expect(finalSource).toContain("- [ ] Added in scan two");
    expect(finalSource).not.toContain("- [ ] Should not be added");
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: converged-diminishing.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planScanCount: null,
          planScansExecuted: 2,
          planConvergenceReason: "converged-diminishing",
          planConvergenceOutcome: "converged-diminishing",
          planConverged: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("rejects direct edits that check off unchecked TODO items and restores file", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, "# Roadmap\n- [x] Existing task\n- [ ] New task\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(fileSystem.readText(markdownFile)).toBe(content);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenLastCalledWith(markdownFile, content);
    expect(events.some((event) => event.kind === "error" && event.message.includes("check off TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });

  it("rejects direct edits that remove checked TODO items and restores file", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [x] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] New task\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile }));

    expect(code).toBe(1);
    expect(fileSystem.readText(markdownFile)).toBe(content);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenLastCalledWith(markdownFile, content);
    expect(events.some((event) => event.kind === "error" && event.message.includes("remove checked TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });

  it("rejects unchecked-to-checked transitions in unlimited mode and restores file", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, "# Roadmap\n- [x] Existing task\n- [ ] New task\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: undefined }));

    expect(code).toBe(1);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(fileSystem.readText(markdownFile)).toBe(content);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenLastCalledWith(markdownFile, content);
    expect(events.some((event) => event.kind === "error" && event.message.includes("check off TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });

  it("rejects checked-item removal in unlimited mode and restores file", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [x] Existing task\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockImplementationOnce(async () => {
      fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] New task\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, scanCount: undefined }));

    expect(code).toBe(1);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(fileSystem.readText(markdownFile)).toBe(content);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenLastCalledWith(markdownFile, content);
    expect(events.some((event) => event.kind === "error" && event.message.includes("remove checked TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });

  it("includes prepend/append advisory guidance in deep prompt context during deep planning", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Build release flow\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });
    const prependPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-prepend.md");
    const appendPath = dependencies.pathOperations.join(dependencies.configDir!.configDir, "plan-append.md");
    const originalReadText = vi.mocked(dependencies.fileSystem.readText).getMockImplementation();

    vi.mocked(dependencies.fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath === prependPath) {
        return "Prefer prerequisite discovery before implementation tasks.";
      }
      if (filePath === appendPath) {
        return "Prefer final verification and handoff checks when applicable.";
      }
      return originalReadText?.(filePath) ?? "";
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Build release flow\n  - [ ] Define release steps\n  - [ ] Validate rollout\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 1 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    const deepPrompt = vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.prompt ?? "";
    expect(deepPrompt).toContain("Optional prepend guidance (advisory)");
    expect(deepPrompt).toContain("Optional append guidance (advisory)");
    expect(deepPrompt).toContain("Prefer prerequisite discovery before implementation tasks.");
    expect(deepPrompt).toContain("Prefer final verification and handoff checks when applicable.");
    expect(deepPrompt).toContain("there is no explicit target file write/edit/create in that child task");
    expect(deepPrompt).toContain("Do NOT use `memory:` when the child task asks to write/edit/create/update any file");
    expect(deepPrompt).toContain("Explicit write-target child examples that must remain normal execution TODOs");
    expect(deepPrompt).toContain("- [ ] Write findings to docs/research-notes.md");
    expect(deepPrompt).toContain("- [ ] Research rollout risks and write findings into docs/rollout-plan.md");
    expect(deepPrompt).toContain("research and write findings into X.md");
    expect(deepPrompt).toContain("split into separate child TODOs when possible");
    expect(deepPrompt).toContain("Author new child memory-capture TODOs with the canonical `memory:` prefix only");
  });

  it("runs deep passes after scan convergence and inserts child TODO items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Build release flow\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Build release flow\n  - [ ] Define release steps\n  - [ ] Validate rollout\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 1 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.artifactPhaseLabel).toBe("plan-deep-01-task-001");
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.artifactExtra).toEqual(
      expect.objectContaining({
        deepPass: 1,
        deepCount: 1,
      }),
    );
    const deepPrompt = vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.prompt ?? "";
    expect(deepPrompt).toContain("## Parent task context");
    expect(deepPrompt).toContain("Build release flow");
    const updated = fileSystem.readText(markdownFile);
    expect(updated).toContain("- [ ] Build release flow\n  - [ ] Define release steps\n  - [ ] Validate rollout\n");
  });

  it("counts deep-pass insertions toward max-items and stops further deep tasks", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = [
      "# Roadmap",
      "- [ ] Parent A",
      "- [ ] Parent B",
      "",
    ].join("\n");
    const { dependencies, workerExecutor, fileSystem, events, artifactStore } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, [
          "# Roadmap",
          "- [ ] Parent A",
          "- [ ] Parent B",
          "  - [ ] Child one",
          "  - [ ] Child two",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 2, maxItems: 1 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("Planner stopped during deep pass 1, task 1")
      && event.message.includes("max-items cap reached")
      && event.message.includes("2/1 TODO items added"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan stop reason: max-items-reached.",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "Plan operation summary: 2 successes, 0 failures. Planning stopped because --max-items limit was reached.",
    });
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 2 TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          planConvergenceReason: "max-items-reached",
          planConvergenceOutcome: "max-items-reached",
          planMaxItemsReached: true,
          planScanCapReached: false,
          planEmergencyCapReached: false,
        }),
      }),
    );
  });

  it("rejects invalid deep-pass edits and restores file", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [x] Completed migration\n- [ ] Build release flow\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Build release flow\n  - [ ] Define release steps\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 1 }));

    expect(code).toBe(1);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(fileSystem.readText(markdownFile)).toBe(content);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenLastCalledWith(markdownFile, content);
    expect(events.some((event) => event.kind === "error" && event.message.includes("remove checked TODO items"))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: true }),
    );
  });

  it("re-parses between deep passes and expands deeper leaf tasks", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Build release flow\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Build release flow\n  - [ ] Child A\n  - [ ] Child B\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Build release flow\n  - [ ] Child A\n    - [ ] Grandchild A1\n  - [ ] Child B\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.artifactExtra).toEqual(
      expect.objectContaining({
        deepPass: 1,
        deepCount: 2,
      }),
    );
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[2]?.[0]?.artifactExtra).toEqual(
      expect.objectContaining({
        deepPass: 2,
        deepCount: 2,
      }),
    );
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Build release flow\n  - [ ] Child A\n    - [ ] Grandchild A1\n  - [ ] Child B\n");

    const deepPromptForChildB = vi.mocked(workerExecutor.runWorker).mock.calls[2]?.[0]?.prompt ?? "";
    const deepPromptForChildA = vi.mocked(workerExecutor.runWorker).mock.calls[3]?.[0]?.prompt ?? "";
    expect(deepPromptForChildB).toContain("Parent task: Child B");
    expect(deepPromptForChildA).toContain("Parent task: Child A");
  });

  it("runs a single deep pass and inserts first-level child TODO items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Parent task\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Parent task\n  - [ ] Child one\n  - [ ] Child two\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 1 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workerExecutor.runWorker).mock.calls[1]?.[0]?.artifactPhaseLabel).toBe("plan-deep-01-task-001");
    const updated = fileSystem.readText(markdownFile);
    expect(updated).toContain("- [ ] Parent task\n  - [ ] Child one\n  - [ ] Child two\n");
  });

  it("runs multiple deep passes and inserts nested descendants", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Parent task\n";
    const { dependencies, workerExecutor, fileSystem } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Parent task\n  - [ ] Child\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        fileSystem.writeText(markdownFile, "# Roadmap\n- [ ] Parent task\n  - [ ] Child\n    - [ ] Grandchild\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(3);
    const finalSource = fileSystem.readText(markdownFile);
    expect(finalSource).toContain("- [ ] Parent task\n  - [ ] Child\n    - [ ] Grandchild\n");
  });

  it("stops deep passes early when a pass adds no child TODO items", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Parent task\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "- [ ] Should not run\n",
        stderr: "",
      });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 3 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Deep planning converged at pass 1"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("no child TODO items were added"))).toBe(true);
  });

  it("skips deep worker execution when there are no unchecked leaf tasks", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Parent\n  - [x] Existing child\n";
    const { dependencies, workerExecutor, fileSystem, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ source: markdownFile, deep: 2 }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Deep planning converged at pass 1: no leaf TODO items without children."))).toBe(true);
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
    exists: vi.fn((filePath: string) => filePath === options.markdownFile),
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

function createOptions(
  overrides: Partial<PlanTaskOptions> & { workerCommand?: string[]; transport?: string } = {},
): PlanTaskOptions {
  const { workerCommand, transport: _transport, ...optionOverrides } = overrides;
  void _transport;

  return {
    source: "roadmap.md",
    scanCount: 1,
    maxItems: undefined,
    mode: "wait",
    workerPattern: inferWorkerPatternFromCommand(workerCommand ?? ["opencode", "run"]),
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
    ...optionOverrides,
  };
}
