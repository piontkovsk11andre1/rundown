import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPlanTask, type PlanTaskDependencies, type PlanTaskOptions } from "../../../src/application/plan-task.js";
import { inferWorkerPatternFromCommand } from "../../../src/domain/worker-pattern.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  CommandExecutor,
  FileSystem,
} from "../../../src/domain/ports/index.js";
import type { FileLock } from "../../../src/domain/ports/file-lock.js";

describe("plan-task", () => {
  it("uses loop template when --loop is enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((filePath: string) => {
      if (filePath.endsWith("/plan-loop.md") || filePath.endsWith("\\plan-loop.md")) {
        return "# Loop Plan Prompt\nloop-task={{task}}";
      }
      if (filePath.endsWith("/plan.md") || filePath.endsWith("\\plan.md")) {
        return "# Standard Plan Prompt\nstandard-task={{task}}";
      }
      return null;
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      printPrompt: true,
      loop: true,
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt mode: loop (--loop enabled)."))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planner template:") && event.message.includes("plan-loop.md"))).toBe(true);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("# Loop Plan Prompt");
    expect(prompt).toContain("loop-task=Roadmap");
    expect(prompt).not.toContain("# Standard Plan Prompt");
  });

  it("keeps using plan.md when --loop is not enabled", async () => {
    const cwd = "/workspace";
    const markdownFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      markdownFile,
      fileContent: "# Roadmap\nBuild a new release process.\n",
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((filePath: string) => {
      if (filePath.endsWith("/plan-loop.md") || filePath.endsWith("\\plan-loop.md")) {
        return "# Loop Plan Prompt\nloop-task={{task}}";
      }
      if (filePath.endsWith("/plan.md") || filePath.endsWith("\\plan.md")) {
        return "# Standard Plan Prompt\nstandard-task={{task}}";
      }
      return null;
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({
      source: markdownFile,
      printPrompt: true,
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt mode: standard (--loop disabled)."))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Planner template:") && event.message.includes("plan.md"))).toBe(true);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("# Standard Plan Prompt");
    expect(prompt).toContain("standard-task=Roadmap");
    expect(prompt).not.toContain("# Loop Plan Prompt");
  });
});

function createDependencies(options: {
  cwd: string;
  markdownFile: string;
  fileContent: string;
  cliBlockExecutor?: CommandExecutor;
}): {
  dependencies: PlanTaskDependencies;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];
  let currentContent = options.fileContent;

  const fileSystem: FileSystem = {
    exists: vi.fn((filePath: string) => filePath === options.markdownFile),
    readText: vi.fn((filePath: string) => {
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
    workerExecutor: {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
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
